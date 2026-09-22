import fs from 'node:fs';

// Console writes that can't stall the orchestrator's event loop.
//
// The orchestrator is the only reader of the `[backend]` and `[frontend]`
// pipes, and it writes every line it reads straight to the dev console. That
// coupling froze all of Lattice on 2026-08-20:
//
//   1. Windows pauses console output while a QuickEdit selection is in
//      progress — clicking or dragging in the `npm run dev` window is enough,
//      and it stays paused until Esc. (`Ctrl+S` flow control does the same on
//      a POSIX terminal.)
//   2. Node deliberately makes TTY writes blocking (`tty.WriteStream` calls
//      `this._handle.setBlocking(true)`), so `process.stdout.write` parked this
//      process's event loop inside the write syscall.
//   3. With nobody draining them, the children's stdio pipes filled — and
//      stdio pipe writes are synchronous on Windows too, so the backend froze
//      solid at 0% CPU: no HTTP, no WS, no agent Stop-hook callbacks, a merge
//      run's `run.lock` held indefinitely. Every project sat on "Scanning…".
//
// `fs.write()` runs on libuv's thread pool, so the same stalled write costs a
// thread instead of the loop. One write in flight at a time keeps output
// ordered and caps the damage to that single thread; the queue behind it is
// bounded, and the oldest lines go first when it overflows.
//
// Writing bytes to fd 1 skips libuv's TTY layer, which on Windows also means
// skipping its ANSI-escape emulation — but that layer only emulates when the
// console can't do VT itself, and every Windows release Node 24 supports
// (1809+) can. Touching `process.stdout` below is what triggers libuv's probe
// (and, with it, `ENABLE_VIRTUAL_TERMINAL_PROCESSING`), so the `[backend]` /
// `[frontend]` colors still render.
void process.stdout.isTTY;

const MAX_QUEUED_BYTES = 256 * 1024;
// Back-off before retrying a write the non-blocking fd refused (EAGAIN).
const EAGAIN_RETRY_MS = 25;

// Exported for tests, which point a sink at a temp file rather than the
// runner's own stdout.
export function createSink(fd) {
  // `retry`: a pending EAGAIN back-off; no write is in flight while it is armed.
  const state = { queue: [], queuedBytes: 0, writing: false, dropped: 0, retry: null };

  function enqueue(chunk) {
    if (chunk.length === 0) return;
    state.queue.push(chunk);
    state.queuedBytes += chunk.length;
    evictOverCap();
  }

  // Back to the FRONT: an unwritten chunk is older than anything queued while
  // its write was in flight (appending it split a line around newer output).
  function requeueFront(chunk) {
    state.queue.unshift(chunk);
    state.queuedBytes += chunk.length;
    evictOverCap();
  }

  function evictOverCap() {
    // Drop whole chunks from the front: while output is stalled the newest
    // lines are the ones worth keeping, and half a line is worse than none.
    while (state.queuedBytes > MAX_QUEUED_BYTES && state.queue.length > 1) {
      state.queuedBytes -= state.queue.shift().length;
      state.dropped++;
    }
  }

  function pump() {
    if (state.writing || state.retry || state.queue.length === 0) return;
    const chunk = state.queue.length === 1 ? state.queue[0] : Buffer.concat(state.queue);
    state.queue = [];
    state.queuedBytes = 0;
    state.writing = true;
    fs.write(fd, chunk, (err, written) => {
      state.writing = false;
      // EAGAIN: the fd is non-blocking (libuv sets O_NONBLOCK on a piped
      // fd 1/2 on POSIX) and the reader's pipe buffer is full — the stall this
      // module exists for, not a dead reader. Dropping the chunk silently lost
      // every burst past the pipe buffer; put it back and retry shortly.
      if (err && (err.code === 'EAGAIN' || err.code === 'EWOULDBLOCK')) {
        requeueFront(chunk);
        state.retry = setTimeout(() => {
          state.retry = null;
          pump();
        }, EAGAIN_RETRY_MS);
        state.retry.unref?.();
        return;
      }
      if (!err && written < chunk.length) requeueFront(chunk.subarray(written));
      else if (!err && state.dropped > 0 && state.queue.length === 0) {
        // Only worth saying once output is moving again.
        const n = state.dropped;
        state.dropped = 0;
        enqueue(
          Buffer.from(
            `[lattice] dropped ${n} console write(s) while output was paused ` +
              `(a text selection in this window pauses it — press Esc to resume)\n`,
            'utf8',
          ),
        );
      }
      pump();
    });
  }

  return {
    write(text) {
      try {
        enqueue(Buffer.from(text, 'utf8'));
        pump();
      } catch {
        /* logging must never break the dev runner */
      }
    },
  };
}

export const stdoutSink = createSink(1);
export const stderrSink = createSink(2);
