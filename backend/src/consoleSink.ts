// A stalled console must never be able to freeze the backend.
//
// The failure this exists to prevent, observed 2026-08-20: the backend went
// completely unresponsive — every project stuck on "Scanning…", `/api/health`
// timing out, agent Stop-hook `curl`s hanging for hours, a merge run's
// `run.lock` never released — while the process sat at 0% CPU with its TCP
// listener still accepting connections. The cause was a *text selection* in the
// `npm run dev` console window:
//
//   1. Windows pauses all output to a console while a QuickEdit selection is in
//      progress, so `WriteConsole` blocks until the user presses Esc.
//   2. Node makes TTY writes blocking on purpose (`tty.WriteStream` does
//      `this._handle.setBlocking(true)` — "prevents interleaved or dropped
//      output"), so `scripts/orchestrate.mjs` blocked its own event loop there
//      and stopped draining the `[backend]` pipe.
//   3. Stdio pipe writes are synchronous on Windows too, so once that pipe's
//      64KB buffer filled, the backend's next `console.log` blocked its event
//      loop — every request, timer, socket and hook callback with it.
//
// Nothing above is recoverable from inside the process: `setBlocking(false)` on
// the stdio handle does not help (measured), and the block happens inside the
// write syscall, so there is no "is it stalled?" to test beforehand. The only
// fix is to stop performing that write on the event loop at all.
//
// So console output goes through an async `fs.write()` — which libuv runs on
// the thread pool — with at most one write in flight per fd, and a bounded
// queue behind it. A stalled console now costs log lines, never liveness: the
// queue fills, the oldest lines are dropped, and a note about how many is
// printed once output flows again.
//
// Deliberately not dev-only: any consumer that stops reading (a `| tee` in a
// paused shell, a full CI log pipe) is the same trap in production.

import fs from 'node:fs';
import { Writable } from 'node:stream';

// Enough headroom to ride out a brief stall without losing anything; small
// enough that a console left selected for hours can't grow the heap.
const MAX_QUEUED_BYTES = 256 * 1024;

type Sink = {
  fd: number;
  queue: Buffer[];
  queuedBytes: number;
  writing: boolean;
  dropped: number;
};

function createSink(fd: number): Sink {
  return { fd, queue: [], queuedBytes: 0, writing: false, dropped: 0 };
}

const sinks = new Map<number, Sink>();

function sinkFor(fd: number): Sink {
  let sink = sinks.get(fd);
  if (!sink) {
    sink = createSink(fd);
    sinks.set(fd, sink);
  }
  return sink;
}

function pump(sink: Sink): void {
  if (sink.writing || sink.queue.length === 0) return;
  const chunk = sink.queue.length === 1 ? sink.queue[0] : Buffer.concat(sink.queue);
  sink.queue = [];
  sink.queuedBytes = 0;
  sink.writing = true;
  let done = false;
  const onWritten = (err: NodeJS.ErrnoException | null, written: number) => {
    // fs.write can report a short write; re-queue the tail so a long line is
    // never silently truncated.
    if (done) return;
    done = true;
    sink.writing = false;
    if (!err && written < chunk.length) {
      enqueue(sink, chunk.subarray(written));
    }
    // On error (EPIPE when the reader is gone, EBADF when the fd is closed)
    // drop the chunk — there is nowhere to report it to.
    if (!err) reportDrops(sink);
    pump(sink);
  };
  try {
    fs.write(sink.fd, chunk, onWritten);
  } catch {
    // Synchronous throw (a closed fd): treat as written-and-lost.
    sink.writing = false;
  }
}

function enqueue(sink: Sink, chunk: Buffer): void {
  if (chunk.length === 0) return;
  sink.queue.push(chunk);
  sink.queuedBytes += chunk.length;
  // Drop from the FRONT: when output is stalled the newest lines are the ones
  // worth keeping, and they're the ones that explain what the process is doing
  // now. Whole chunks only — a half-written line is worse than a missing one.
  while (sink.queuedBytes > MAX_QUEUED_BYTES && sink.queue.length > 1) {
    const evicted = sink.queue.shift() as Buffer;
    sink.queuedBytes -= evicted.length;
    sink.dropped++;
  }
}

// Told about the drops only once output is moving again — writing this while
// the console is still stalled would just be one more line to drop.
function reportDrops(sink: Sink): void {
  if (sink.dropped === 0 || sink.queue.length > 0) return;
  const n = sink.dropped;
  sink.dropped = 0;
  enqueue(
    sink,
    Buffer.from(
      `[lattice] dropped ${n} log write(s) while console output was stalled ` +
        `(a text selection in the dev console pauses it — press Esc there to resume)\n`,
      'utf8',
    ),
  );
}

// Queue one already-formatted chunk of console output. Never blocks, never
// throws.
export function writeToSink(fd: number, text: string): void {
  const sink = sinkFor(fd);
  enqueue(sink, Buffer.from(text, 'utf8'));
  pump(sink);
}

// A `Writable` over the sink, for handing to `new console.Console(...)` so
// Node keeps doing all of the console formatting itself. `_write` completes
// immediately: back-pressure is what we are trying to avoid propagating.
export function createSinkStream(fd: number): NodeJS.WritableStream {
  return new Writable({
    decodeStrings: false,
    write(chunk: Buffer | string, _enc: BufferEncoding, cb: (err?: Error | null) => void) {
      try {
        const sink = sinkFor(fd);
        enqueue(sink, Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8'));
        pump(sink);
      } catch {
        /* logging must never break logging */
      }
      cb();
    },
  });
}

// Best-effort synchronous flush for the fatal path, where the process is about
// to `process.exit()` and pending thread-pool writes would be dropped.
//
// Skipped when a write is already in flight or the queue is large: those are
// exactly the states that mean the console is stalled, and blocking there would
// hang a process that is trying to die. The crash file on disk carries the same
// lines anyway (crashLog.ts writes it synchronously), so this is a convenience
// for the terminal the user is watching, not the record of what happened.
const FLUSH_SYNC_MAX_BYTES = 64 * 1024;

// Queued output would otherwise die with the process — `process.exit()` doesn't
// wait for thread-pool writes. That matters for the last line before a
// deliberate exit (`[lattice-backend] startup error: …` is one), which the user
// is watching their console for.
process.once('exit', () => flushSinksSyncIfIdle());

export function flushSinksSyncIfIdle(): void {
  for (const sink of sinks.values()) {
    if (sink.writing || sink.queue.length === 0) continue;
    if (sink.queuedBytes > FLUSH_SYNC_MAX_BYTES) continue;
    const chunk = Buffer.concat(sink.queue);
    sink.queue = [];
    sink.queuedBytes = 0;
    try {
      fs.writeSync(sink.fd, chunk);
    } catch {
      /* nowhere left to write it */
    }
  }
}

// True while a write is parked on the thread pool — i.e. the console really is
// stalled right now. Matters at exit: libuv joins its thread pool from an
// atexit handler, so `process.exit()` never returns while one of its threads is
// stuck inside a write. See processGuards.ts.
export function hasWriteInFlight(): boolean {
  for (const sink of sinks.values()) if (sink.writing) return true;
  return false;
}

// Test seam: current queue depth + how many writes have been dropped.
export function sinkState(fd: number): { queuedBytes: number; dropped: number } {
  const sink = sinks.get(fd);
  return sink
    ? { queuedBytes: sink.queuedBytes, dropped: sink.dropped }
    : { queuedBytes: 0, dropped: 0 };
}
