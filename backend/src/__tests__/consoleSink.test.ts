import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { sinkState, writeToSink } from '../consoleSink.js';
import { createSink } from '../../../scripts/orchestrate/consoleSink.mjs';

// Regression for the 2026-08-20 freeze: the whole backend went unresponsive â€”
// every project stuck on "Scanningâ€¦", `/api/health` timing out, agent Stop-hook
// callbacks hanging, a merge run's run.lock never released â€” at 0% CPU, because
// somebody had a text selection open in the `npm run dev` console window.
// Windows pauses console output during a selection; Node makes TTY writes
// blocking on purpose; so the dev orchestrator blocked mid-write and stopped
// draining the [backend] pipe, and once that pipe's 64KB buffer filled the
// backend's next console.log blocked its event loop with everything on it.
//
// The property under test is therefore liveness, not formatting: console output
// must never be able to park the event loop, no matter how stalled its reader.

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function tempFd(name: string): Promise<{ fd: number; file: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lattice-sink-'));
  const file = path.join(dir, name);
  return { fd: fsSync.openSync(file, 'w'), file };
}

async function waitForDrain(fd: number, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (sinkState(fd).queuedBytes === 0) {
      await sleep(30); // let the in-flight write land
      if (sinkState(fd).queuedBytes === 0) return;
    }
    await sleep(10);
  }
  throw new Error('sink did not drain');
}

// ---------------------------------------------------------------------------
// The liveness contract, end to end
// ---------------------------------------------------------------------------

// The child floods stdout while its parent deliberately never reads that pipe â€”
// the exact shape of a paused console. It reports liveness on stderr (which the
// parent does drain), and the parent starts reading stdout partway through,
// which is what pressing Esc in the real console does. Before the fix this
// child froze on its first blocked write and never emitted another beat.
const FLOOD_CHILD = `
(async () => {
  const { installCrashLogging } = await import(process.env.CRASHLOG_URL);
  installCrashLogging('backend');
  let beats = 0;
  const beat = setInterval(() => { console.error('BEAT ' + ++beats); }, 20);
  // ~80KB per tick â€” past a 64KB pipe buffer on the very first one.
  const flood = setInterval(() => {
    for (let i = 0; i < 20; i++) console.log('x'.repeat(4000));
  }, 5);
  setTimeout(() => {
    clearInterval(beat); clearInterval(flood);
    // Exit code, not a log line: reaching its own shutdown is the assertion,
    // and a queued line can legitimately be dropped when output is stalled.
    process.exit(7);
  }, 2500);
})();
`;

test('a stalled stdout reader cannot freeze the event loop', async () => {
  const child = spawn(process.execPath, ['--import', 'tsx', '-e', FLOOD_CHILD], {
    env: { ...process.env, CRASHLOG_URL: new URL('../crashLog.ts', import.meta.url).href },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (d) => (stderr += d.toString()));
  // stdout is left unread â€” the stall. Beats counted before it resumes are the
  // proof that the loop kept running through it. Timed from the first beat
  // rather than from spawn, so a slow tsx boot on a loaded machine can't eat
  // the window and make this flaky.
  let beatsDuringStall = 0;
  let unstall: NodeJS.Timeout | undefined;
  const resume = () => {
    beatsDuringStall = (stderr.match(/BEAT /g) ?? []).length;
    child.stdout.resume(); // ...and this is the user pressing Esc.
  };
  child.stderr.on('data', () => {
    if (!unstall && stderr.includes('BEAT ')) unstall = setTimeout(resume, 400);
  });

  const outcome = await new Promise<{ code: number | null; timedOut: boolean }>((resolve) => {
    const killTimer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve({ code: null, timedOut: true });
    }, 15000);
    child.on('close', (code) => {
      clearTimeout(killTimer);
      if (unstall) clearTimeout(unstall);
      resolve({ code, timedOut: false });
    });
  });

  assert.ok(
    beatsDuringStall >= 5,
    `timers must keep firing while output is stalled (saw ${beatsDuringStall})`,
  );
  assert.equal(outcome.timedOut, false, 'the child never recovered after the reader resumed');
  assert.equal(outcome.code, 7, 'child must have reached its own shutdown, not been killed');
});

// The flip side of writing off the event loop: `process.exit` doesn't wait for
// a thread-pool write, so the sink flushes what it has from an exit handler.
// Without that the last line before a deliberate exit — `[lattice-backend]
// startup error: …`, the one the user is watching their console for — vanishes.
const EXITING_CHILD = `
(async () => {
  const { installCrashLogging } = await import(process.env.CRASHLOG_URL);
  installCrashLogging('backend');
  console.log('[lattice-backend] startup error: boom');
  process.exit(3);
})();
`;

test('the last line before a deliberate exit still reaches the console', async () => {
  const child = spawn(process.execPath, ['--import', 'tsx', '-e', EXITING_CHILD], {
    env: { ...process.env, CRASHLOG_URL: new URL('../crashLog.ts', import.meta.url).href },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  child.stdout.on('data', (d) => (stdout += d.toString()));
  const code = await new Promise<number | null>((resolve) => {
    const killTimer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve(null);
    }, 8000);
    child.on('close', (c) => {
      clearTimeout(killTimer);
      resolve(c);
    });
  });
  assert.equal(code, 3);
  assert.match(stdout, /startup error: boom/, 'the exit must not swallow the last line');
});

// A fatal error while the console is stalled must still take the process down.
// `process.exit` alone can't: libuv joins its thread pool from an atexit
// handler and the write is parked on one of those threads, so the backend would
// sit there forever holding port 5184 â€” alive enough to keep the port, too dead
// to serve it.
const CRASH_WHILE_STALLED_CHILD = `
(async () => {
  const { installProcessGuards } = await import(process.env.GUARDS_URL);
  installProcessGuards();
  for (let i = 0; i < 40; i++) console.log('x'.repeat(4000)); // fills the pipe
  setTimeout(() => { throw new Error('generic backend failure'); }, 50);
})();
`;

test('a fatal error still exits when console output is stalled', async () => {
  const child = spawn(process.execPath, ['--import', 'tsx', '-e', CRASH_WHILE_STALLED_CHILD], {
    env: { ...process.env, GUARDS_URL: new URL('../processGuards.ts', import.meta.url).href },
    stdio: ['ignore', 'pipe', 'pipe'], // stdout never read
  });
  child.stderr.on('data', () => {});

  const outcome = await new Promise<{ code: number | null; timedOut: boolean }>((resolve) => {
    const killTimer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve({ code: null, timedOut: true });
    }, 8000);
    child.on('close', (code) => {
      clearTimeout(killTimer);
      resolve({ code, timedOut: false });
    });
  });

  assert.equal(outcome.timedOut, false, 'a crashing backend must never become unkillable');
  assert.notEqual(outcome.code, 0, 'fail-fast must still be non-zero');
});

// ---------------------------------------------------------------------------
// Bounding: a stall costs log lines, never memory
// ---------------------------------------------------------------------------

test('the queue is bounded and drops the oldest writes, keeping the newest', async () => {
  const { fd, file } = await tempFd('bounded.log');
  // One synchronous burst: the first chunk goes in flight, everything after it
  // queues, and the cap (256KB) evicts from the front.
  for (let i = 0; i < 400; i++) writeToSink(fd, `line ${i} ` + 'y'.repeat(2000) + '\n');

  assert.ok(sinkState(fd).dropped > 0, 'a burst past the cap must drop');
  assert.ok(
    sinkState(fd).queuedBytes <= 256 * 1024,
    `queue must stay bounded (was ${sinkState(fd).queuedBytes})`,
  );

  await waitForDrain(fd);
  const body = await fs.readFile(file, 'utf8');
  assert.match(body, /^line 0 /, 'the write already in flight still lands');
  assert.match(body, /line 399 /, 'the newest lines are the ones kept');
  assert.match(body, /dropped \d+ log write\(s\)/, 'the loss must be reported, not silent');
  fsSync.closeSync(fd);
});

test('writes land in order and unstalled output is never dropped', async () => {
  const { fd, file } = await tempFd('ordered.log');
  for (let i = 0; i < 20; i++) {
    writeToSink(fd, `line ${i}\n`);
    await sleep(5); // paced: nothing should ever queue past the cap
  }
  await waitForDrain(fd);
  const lines = (await fs.readFile(file, 'utf8')).trim().split('\n');
  assert.deepEqual(
    lines,
    Array.from({ length: 20 }, (_, i) => `line ${i}`),
    'ordering must be preserved and nothing dropped',
  );
  assert.equal(sinkState(fd).dropped, 0);
  fsSync.closeSync(fd);
});

// ---------------------------------------------------------------------------
// The dev orchestrator's copy â€” same contract, plain .mjs so `npm run dev`
// needs no build step
// ---------------------------------------------------------------------------

test('orchestrator sink: ordered, bounded, and reports what it dropped', async () => {
  const { fd, file } = await tempFd('orchestrator.log');
  const sink = createSink(fd);

  sink.write('[backend] first\n');
  await sleep(30);
  for (let i = 0; i < 400; i++) sink.write(`[backend] burst ${i} ` + 'z'.repeat(2000) + '\n');

  const deadline = Date.now() + 5000;
  let body = '';
  while (Date.now() < deadline) {
    body = await fs.readFile(file, 'utf8');
    if (/dropped \d+ console write\(s\)/.test(body)) break;
    await sleep(25);
  }
  assert.match(body, /^\[backend\] first\n/);
  assert.match(body, /burst 399 /, 'newest survives');
  assert.match(body, /dropped \d+ console write\(s\)/, 'loss is reported once output resumes');
  fsSync.closeSync(fd);
});
