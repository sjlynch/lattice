import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  IsolatedAnalyzer,
  WorkerUnavailableError,
} from '../health/watcher/isolatedAnalyze.js';
import type { WorkerData, WorkerHandle } from '../health/watcher/isolatedAnalyze.js';

// Controllable fake worker mirroring the surface IsolatedAnalyzer uses
// (on / postMessage / terminate + emitted 'message'/'error'/'exit').
class FakeWorker implements WorkerHandle {
  handlers: Record<'message' | 'error' | 'exit', ((a: unknown) => void)[]> = {
    message: [],
    error: [],
    exit: [],
  };
  posted: unknown[] = [];
  terminated = false;
  constructor(readonly data: WorkerData) {}
  on(event: 'message' | 'error' | 'exit', cb: (a: unknown) => void): this {
    this.handlers[event].push(cb);
    return this;
  }
  postMessage(v: unknown): void {
    this.posted.push(v);
  }
  terminate(): Promise<number> {
    this.terminated = true;
    return Promise.resolve(0);
  }
  emit(event: 'message' | 'error' | 'exit', arg?: unknown): void {
    for (const cb of [...this.handlers[event]]) cb(arg);
  }
}

function capturing() {
  const created: FakeWorker[] = [];
  const createWorker = (data: WorkerData): WorkerHandle => {
    const w = new FakeWorker(data);
    created.push(w);
    return w;
  };
  return { created, createWorker };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const opts = (createWorker: ReturnType<typeof capturing>['createWorker'], stallMs = 10_000) => ({
  createWorker,
  analyzeUrl: 'test://analyze',
  stallMs,
});

test('IsolatedAnalyzer: resolves the worker result and reuses one warm worker (serial, in order)', async () => {
  const { created, createWorker } = capturing();
  const a = new IsolatedAnalyzer(opts(createWorker));
  const p1 = a.analyze('one', '.ts', 1);
  const p2 = a.analyze('two', '.ts', 2);

  // Only one worker, and only the first job is in flight (serial queue).
  assert.equal(created.length, 1);
  const w = created[0];
  assert.deepEqual(w.posted, [{ type: 'job', content: 'one', ext: '.ts', loc: 1 }]);

  w.emit('message', { type: 'result', ok: true, metrics: { score: 88 }, imports: ['a'] });
  assert.deepEqual(await p1, { metrics: { score: 88 }, imports: ['a'] });

  // Second job now dispatched on the SAME warm worker — no respawn.
  assert.equal(created.length, 1);
  assert.deepEqual(w.posted[1], { type: 'job', content: 'two', ext: '.ts', loc: 2 });
  w.emit('message', { type: 'result', ok: false });
  assert.equal(await p2, null, 'ok:false means unanalyzable → null (skip)');

  a.dispose();
});

test('IsolatedAnalyzer: a stalled job is skipped (null) and a queued job continues on a fresh worker', async () => {
  const { created, createWorker } = capturing();
  const a = new IsolatedAnalyzer(opts(createWorker, 40));
  const p1 = a.analyze('HANG', '.ts', 1);
  const p2 = a.analyze('ok', '.ts', 1);

  const w0 = created[0];
  assert.equal(w0.posted.length, 1, 'only the in-flight job is sent (serial)');
  // w0 "hangs" on p1 (emit nothing). Wait for the watchdog to terminate it and
  // respawn a fresh worker for the queued job, then respond IMMEDIATELY — before
  // the respawned worker's own stall timer can fire.
  for (let i = 0; i < 100 && created.length < 2; i += 1) await sleep(2);

  assert.equal(w0.terminated, true, 'the hung worker is terminated');
  assert.equal(created.length, 2, 'a fresh worker is respawned for the queued job');
  const w1 = created[1];
  assert.deepEqual(w1.posted[0], { type: 'job', content: 'ok', ext: '.ts', loc: 1 });
  w1.emit('message', { type: 'result', ok: true, metrics: { score: 70 }, imports: [] });

  assert.equal(await p1, null, 'the hung file is skipped, not retried');
  assert.deepEqual(await p2, { metrics: { score: 70 }, imports: [] });

  a.dispose();
});

test('IsolatedAnalyzer: init failure rejects with WorkerUnavailableError and disables the worker', async () => {
  const { created, createWorker } = capturing();
  const a = new IsolatedAnalyzer(opts(createWorker));
  const p = a.analyze('code', '.ts', 1);
  created[0].emit('message', { type: 'init-failed', error: 'no compiled analyze.js' });

  await assert.rejects(p, WorkerUnavailableError);
  assert.equal(created[0].terminated, true);
  // Subsequent calls short-circuit to WorkerUnavailableError without a new worker.
  await assert.rejects(a.analyze('again', '.ts', 1), WorkerUnavailableError);
  assert.equal(created.length, 1);

  a.dispose();
});

test('IsolatedAnalyzer: an unexpected worker exit rejects the in-flight job for in-thread fallback', async () => {
  const { created, createWorker } = capturing();
  const a = new IsolatedAnalyzer(opts(createWorker));
  const p = a.analyze('code', '.ts', 1);
  created[0].emit('exit', 1);

  await assert.rejects(p, WorkerUnavailableError);
  a.dispose();
});

// End-to-end with the REAL persistent worker thread and a genuine infinite loop.
// Uses the plain-JS fixture (no dist dependency). Proves: a hung file is killed
// by the watchdog and skipped, the warm worker is reused / respawned for normal
// files, and — critically — the main event loop keeps running (if analysis ran
// on the main thread this test would hang forever).
test('IsolatedAnalyzer (real worker): a hung file is skipped while normal files analyze and the main thread stays alive', async () => {
  const fixtureUrl = new URL('./helpers/hangAnalyzeFixture.mjs', import.meta.url).href;
  const a = new IsolatedAnalyzer({ analyzeUrl: fixtureUrl, stallMs: 150 });
  let ticks = 0;
  const ticker = setInterval(() => {
    ticks += 1;
  }, 10);
  try {
    const before = await a.analyze('normal before', '.ts', 1);
    assert.ok(before, 'a normal file is analyzed on the warm worker');

    const hung = await a.analyze('HANG please', '.ts', 1);
    assert.equal(hung, null, 'the hung file is skipped by the watchdog');

    const after = await a.analyze('normal after', '.ts', 1);
    assert.ok(after, 'a normal file after the hang analyzes on the respawned worker');

    assert.ok(ticks > 0, 'the main event loop kept ticking while the worker was hung');
  } finally {
    a.dispose();
    clearInterval(ticker);
  }
});

test('IsolatedAnalyzer: giving up after repeated worker deaths is temporary, not permanent', async () => {
  // The in-thread fallback runs the same tree-sitter WASM analyzer on the
  // BACKEND'S MAIN THREAD — the exact arrangement this module exists to escape.
  // Writing the worker off for the life of the process therefore turned three
  // transient deaths into a permanent downgrade, with a hang freezing the event
  // loop and a WASM fault killing the backend outright. The give-up must expire.
  const { created, createWorker } = capturing();
  const a = new IsolatedAnalyzer({ ...opts(createWorker), cooldownMs: 30 });

  // Kill three workers in a row to trip the failure ceiling.
  for (let i = 0; i < 3; i += 1) {
    const p = a.analyze(`file${i}`, '.ts', 1);
    created[created.length - 1].emit('exit', 1);
    await assert.rejects(p, WorkerUnavailableError);
  }
  const spawnedBeforeCooldown = created.length;

  // Written off: no new worker, straight to the in-thread fallback.
  await assert.rejects(a.analyze('during', '.ts', 1), WorkerUnavailableError);
  assert.equal(created.length, spawnedBeforeCooldown, 'no worker is spawned during the cooldown');

  await sleep(50);

  // ...and afterwards it tries again rather than staying degraded forever.
  const revived = a.analyze('after', '.ts', 1);
  assert.equal(created.length, spawnedBeforeCooldown + 1, 'the worker is retried after the cooldown');
  created[created.length - 1].emit('message', {
    type: 'result',
    ok: true,
    metrics: { score: 91 },
    imports: [],
  });
  assert.deepEqual(await revived, { metrics: { score: 91 }, imports: [] });

  a.dispose();
});

test('IsolatedAnalyzer: an init failure stays permanent — retrying it can never help', async () => {
  // The counterpart to the cooldown: init failure means the compiled analyze.js
  // isn't loadable at all, so respawning on a timer would just burn threads.
  const { created, createWorker } = capturing();
  const a = new IsolatedAnalyzer({ ...opts(createWorker), cooldownMs: 10 });
  const p = a.analyze('code', '.ts', 1);
  created[0].emit('message', { type: 'init-failed', error: 'no compiled analyze.js' });
  await assert.rejects(p, WorkerUnavailableError);

  await sleep(40);

  await assert.rejects(a.analyze('later', '.ts', 1), WorkerUnavailableError);
  assert.equal(created.length, 1, 'no respawn, however long we wait');

  a.dispose();
});
