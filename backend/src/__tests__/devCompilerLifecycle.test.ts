import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createCompilerLifecycle, COMPILER_STABLE_MS } from '../../scripts/dev/compilerLifecycle.mjs';
import type { TscWatchChild, TscWatchOptions } from '../../scripts/dev/tscWatch.mjs';
import { createRestartPolicy, DEFERRED_RESTART_POLL_MS } from '../../scripts/dev/restartPolicy.mjs';
import { createBackendLifecycle } from '../../scripts/dev/backendLifecycle.mjs';
import type { spawn } from 'node:child_process';

function fixture(extra: { retryDelays?: number[]; onCompileSucceeded?: () => void } = {}) {
  const children: Array<TscWatchChild> = [];
  const options: TscWatchOptions[] = [];
  const scheduled = new Map<number, { callback: () => void; delay: number }>();
  const records: Array<{ code: number; detail: string; expected: boolean }> = [];
  let timer = 0;
  let at = 1000;
  let successful = 0;
  const lifecycle = createCompilerLifecycle({
    tscBin: 'compiler-fixture',
    startWatch: (_bin, opts = {}) => {
      const child = Object.assign(new EventEmitter(), {
        pid: 987600 + children.length,
        kill: () => true,
        tscSettledPromise: Promise.resolve(null),
      }) as unknown as TscWatchChild;
      children.push(child);
      options.push(opts);
      return child;
    },
    now: () => at,
    retryDelays: extra.retryDelays,
    schedule: (callback, delay) => {
      const id = ++timer;
      scheduled.set(id, { callback, delay });
      return id as unknown as ReturnType<typeof setTimeout>;
    },
    unschedule: (id) => { scheduled.delete(id as unknown as number); },
    record: (_label, code, details) => { records.push({ code, ...details }); },
    onCompileSucceeded: () => { successful++; extra.onCompileSucceeded?.(); },
  });
  const retry = () => {
    const [id, item] = [...scheduled][0];
    scheduled.delete(id);
    item.callback();
    return item.delay;
  };
  return { lifecycle, children, options, scheduled, records, retry,
    advance(ms: number) { at += ms; }, successful: () => successful };
}

test('exit -1 retries only the compiler and requires a successful replacement compile', () => {
  const f = fixture();
  f.lifecycle.start();
  assert.equal(f.options[0].polling, false);
  f.options[0].onCompileComplete!({ successful: true, errors: 0 });
  assert.equal(f.lifecycle.canRestartBackend(), true);
  f.children[0].emit('exit', 4294967295, null);
  assert.equal(f.lifecycle.canRestartBackend(), false);
  assert.equal(f.records[0].code, 4294967295);
  assert.match(f.records[0].detail, /code alone does not identify/);
  assert.match(f.records[0].detail, /pid=987600; node=v/);
  assert.equal(f.retry(), 1000);
  assert.equal(f.children.length, 2);
  assert.equal(f.options[1].polling, true);
  f.options[1].onCompileComplete!({ successful: false, errors: 1 });
  assert.equal(f.lifecycle.canRestartBackend(), false);
  f.options[1].onCompileComplete!({ successful: true, errors: 0 });
  assert.equal(f.lifecycle.canRestartBackend(), true);
  f.lifecycle.stop();
});

test('death before the first settle never marks compilation healthy', () => {
  const f = fixture();
  f.lifecycle.start();
  f.children[0].emit('exit', 1, null);
  f.options[0].onCompileComplete!({ successful: true, errors: 0 });
  assert.equal(f.lifecycle.canRestartBackend(), false);
  assert.equal(f.successful(), 0);
  f.lifecycle.stop();
});

test('successful settle followed by immediate death still exhausts the bounded retry budget', () => {
  const f = fixture({ retryDelays: [1, 2] });
  f.lifecycle.start();
  for (let i = 0; i < 3; i++) {
    f.options[i].onCompileComplete!({ successful: true, errors: 0 });
    f.children[i].emit('exit', 4294967295, null);
    if (i < 2) assert.equal(f.retry(), i + 1);
  }
  assert.equal(f.children.length, 3);
  assert.equal(f.scheduled.size, 0);
  assert.equal(f.lifecycle.canRestartBackend(), false);
  f.lifecycle.stop();
});

test('a sustained successful compiler run replenishes its retry budget', () => {
  const f = fixture({ retryDelays: [1, 2] });
  f.lifecycle.start();
  f.children[0].emit('exit', 1, null);
  f.retry();
  f.options[1].onCompileComplete!({ successful: true, errors: 0 });
  f.advance(COMPILER_STABLE_MS);
  f.children[1].emit('exit', 1, null);
  assert.equal(f.retry(), 1);
  f.lifecycle.stop();
});

test('shutdown cancels backoff and fences a previously queued retry callback', () => {
  const f = fixture();
  f.lifecycle.start();
  f.children[0].emit('exit', 1, null);
  const callback = [...f.scheduled.values()][0].callback;
  f.lifecycle.stop();
  assert.equal(f.scheduled.size, 0);
  callback();
  assert.equal(f.children.length, 1);
  f.options[0].onCompileComplete!({ successful: true, errors: 0 });
  assert.equal(f.lifecycle.canRestartBackend(), false);
});

test('spawn errors are observed once; a live child operation error never creates a duplicate compiler', () => {
  const f = fixture();
  f.lifecycle.start();
  f.children[0].emit('error', new Error('spawn EAGAIN'));
  f.children[0].emit('exit', 1, null);
  assert.equal(f.records.length, 1);
  assert.equal(f.scheduled.size, 1);
  f.retry();
  f.children[1].emit('spawn');
  f.children[1].emit('error', new Error('kill EPERM'));
  assert.equal(f.scheduled.size, 0);
  f.lifecycle.start();
  assert.equal(f.children.length, 2);
  f.lifecycle.stop();
});

test('a synchronous spawn throw schedules a bounded repair without escaping the supervisor', () => {
  let retries = 0;
  const lifecycle = createCompilerLifecycle({
    tscBin: 'fixture', startWatch: () => { throw new Error('spawn threw'); },
    record: () => {}, schedule: () => { retries++; return 1 as unknown as ReturnType<typeof setTimeout>; },
    unschedule: () => {},
  });
  assert.doesNotThrow(() => lifecycle.start());
  assert.equal(retries, 1);
  assert.equal(lifecycle.canRestartBackend(), false);
  lifecycle.stop();
});

test('compiler repair fences pending deferred restarts and applies downtime edits only after success and lock release', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  let locked = true;
  let signature = 'initial';
  let mtime = 100;
  const restarts: string[] = [];
  let policy!: ReturnType<typeof createRestartPolicy>;
  const f = fixture({ onCompileSucceeded: () => policy.onCompileSucceeded() });
  policy = createRestartPolicy({
    restartBackend: (reason) => { restarts.push(reason); return true; },
    canRestart: f.lifecycle.canRestartBackend,
    operationInFlight: () => locked, workflowInFlight: () => locked,
    readDistContentSignature: () => signature, readNewestDistMtime: () => mtime,
    now: () => 1000,
  });
  policy.resetDistBaseline();
  policy.startDeferredPoll();
  f.lifecycle.start();
  f.options[0].onCompileComplete!({ successful: true, errors: 0 });
  assert.equal(restarts.length, 0, 'cold identical re-emit must not restart');
  signature = 'new code'; mtime = 200;
  policy.onDistChanged(); // a live workflow holds the first pending rebuild
  f.children[0].emit('exit', 4294967295, null);
  locked = false;
  t.mock.timers.tick(DEFERRED_RESTART_POLL_MS);
  assert.equal(restarts.length, 0, 'poll must not apply pending output while compiler is down');
  f.retry();
  f.options[1].onCompileComplete!({ successful: false, errors: 3 });
  t.mock.timers.tick(DEFERRED_RESTART_POLL_MS);
  assert.equal(restarts.length, 0);
  locked = true;
  f.options[1].onCompileComplete!({ successful: true, errors: 0 });
  assert.equal(restarts.length, 0, 'successful recovery must still respect workflow locks');
  locked = false;
  t.mock.timers.tick(DEFERRED_RESTART_POLL_MS);
  assert.equal(restarts.length, 1);
  f.lifecycle.stop();
  policy.stopDeferredPoll();
});

test('compiler repair with unchanged bytes does not restart; changed bytes with equal mtimes still catch up', () => {
  let signature = 'original';
  let count = 0;
  let ready = false;
  const policy = createRestartPolicy({
    restartBackend: () => { count++; return true; },
    canRestart: () => ready, operationInFlight: () => false,
    readDistContentSignature: () => signature, readNewestDistMtime: () => 100,
  });
  policy.resetDistBaseline();
  ready = true;
  policy.onCompileSucceeded();
  assert.equal(count, 0);
  ready = false;
  signature = 'edited during outage';
  policy.onDistChanged();
  policy.onCompileSucceeded();
  assert.equal(count, 0);
  ready = true;
  policy.onCompileSucceeded();
  assert.equal(count, 1);
  policy.stopDeferredPoll();
});

test('shutdown clears dist debounce even when no deferred poll was started', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  let count = 0;
  const policy = createRestartPolicy({ restartBackend: () => { count++; return true; } });
  policy.scheduleDistChanged('change', 'index.js');
  policy.stopDeferredPoll();
  t.mock.timers.tick(10000);
  policy.scheduleDistChanged('change', 'late.js');
  policy.onDistChanged();
  policy.onCompileSucceeded();
  policy.startDeferredPoll();
  t.mock.timers.tick(10000);
  assert.equal(count, 0);
});

test('a new compilation between backend restart kill and exit postpones spawning until fresh output completes', () => {
  let ready = true;
  const children: EventEmitter[] = [];
  const backend = createBackendLifecycle({
    copyAssetsBeforeRespawn() {}, isShuttingDown: () => false, onExitDuringShutdown() {},
    canSpawnBackend: () => ready,
    probePort: async () => false, // never probe the real port from a unit test
    spawnProcess: (() => {
      const child = Object.assign(new EventEmitter(), { kill: () => true });
      children.push(child);
      return child;
    }) as unknown as typeof spawn,
  });
  backend.start();
  assert.equal(backend.restartBackend('successful compile'), true);
  ready = false;
  children[0].emit('exit', 0, null);
  assert.equal(children.length, 1, 'partial output must not spawn a backend');
  assert.equal(backend.needsStart(), true);
  const policy = createRestartPolicy({
    restartBackend: backend.restartBackend, needsBackendStart: backend.needsStart,
    canRestart: () => ready, operationInFlight: () => false,
    readDistContentSignature: () => 'same latest output', readNewestDistMtime: () => 100,
  });
  policy.resetDistBaseline();
  ready = true;
  policy.onCompileSucceeded();
  assert.equal(children.length, 2, 'a missing backend must start even when output signature matches');
  policy.stopDeferredPoll();
});

test('a failed asynchronous backend kill leaves new compiled bytes eligible for retry', () => {
  let signature = 'running';
  let kills = 0;
  const children: EventEmitter[] = [];
  let policy!: ReturnType<typeof createRestartPolicy>;
  const backend = createBackendLifecycle({
    copyAssetsBeforeRespawn() {}, isShuttingDown: () => false, onExitDuringShutdown() {},
    onBackendSpawned: () => policy.onBackendSpawned(),
    probePort: async () => false, // never probe the real port from a unit test
    spawnProcess: (() => {
      const child = Object.assign(new EventEmitter(), { kill: () => { kills++; return true; } });
      children.push(child);
      return child;
    }) as unknown as typeof spawn,
  });
  policy = createRestartPolicy({
    restartBackend: backend.restartBackend, needsBackendStart: backend.needsStart,
    operationInFlight: () => false, deferBaselineUntilSpawn: true,
    readDistContentSignature: () => signature, readNewestDistMtime: () => 100,
  });
  backend.start();
  children[0].emit('spawn');
  signature = 'compiled update';
  policy.onCompileSucceeded();
  assert.equal(kills, 1);
  children[0].emit('error', new Error('kill EPERM'));
  policy.onCompileSucceeded();
  assert.equal(kills, 2, 'unapplied bytes must still cause a retry');
  children[0].emit('exit', 0, null);
  children[1].emit('spawn');
  policy.onCompileSucceeded();
  assert.equal(kills, 2, 'actual spawn commits the completed output baseline');
  policy.stopDeferredPoll();
});

test('a newer successful compile during a pending backend kill is baselined on actual spawn', () => {
  let signature = 'initial';
  let kills = 0;
  const children: EventEmitter[] = [];
  let policy!: ReturnType<typeof createRestartPolicy>;
  const backend = createBackendLifecycle({
    copyAssetsBeforeRespawn() {}, isShuttingDown: () => false, onExitDuringShutdown() {},
    onBackendSpawned: () => policy.onBackendSpawned(),
    probePort: async () => false, // never probe the real port from a unit test
    spawnProcess: (() => {
      const child = Object.assign(new EventEmitter(), { kill: () => { kills++; return true; } });
      children.push(child);
      return child;
    }) as unknown as typeof spawn,
  });
  policy = createRestartPolicy({
    restartBackend: backend.restartBackend, needsBackendStart: backend.needsStart,
    operationInFlight: () => false, deferBaselineUntilSpawn: true,
    readDistContentSignature: () => signature, readNewestDistMtime: () => 100,
  });
  backend.start(); children[0].emit('spawn');
  signature = 'compile A'; policy.onCompileSucceeded();
  signature = 'compile B'; policy.onCompileSucceeded();
  assert.equal(kills, 1);
  children[0].emit('exit', 0, null);
  children[1].emit('spawn');
  policy.onCompileSucceeded();
  assert.equal(kills, 1, 'spawn used B, so an identical later compile must not restart again');
  policy.stopDeferredPoll();
});

test('spawn commits its captured candidate even when the next compilation is already underway', () => {
  let signature = 'A';
  let ready = true;
  let kills = 0;
  const children: EventEmitter[] = [];
  let policy!: ReturnType<typeof createRestartPolicy>;
  const backend = createBackendLifecycle({
    copyAssetsBeforeRespawn() {}, isShuttingDown: () => false, onExitDuringShutdown() {},
    canSpawnBackend: () => ready,
    captureBackendVersion: () => policy.captureDistBaseline(),
    onBackendSpawned: (candidate) => policy.onBackendSpawned(candidate),
    probePort: async () => false, // never probe the real port from a unit test
    spawnProcess: (() => {
      const child = Object.assign(new EventEmitter(), { kill: () => { kills++; return true; } });
      children.push(child); return child;
    }) as unknown as typeof spawn,
  });
  policy = createRestartPolicy({
    restartBackend: backend.restartBackend, needsBackendStart: backend.needsStart,
    canRestart: () => ready, operationInFlight: () => false, deferBaselineUntilSpawn: true,
    readDistContentSignature: () => signature, readNewestDistMtime: () => 100,
  });
  backend.start(); children[0].emit('spawn');
  signature = 'B'; policy.onCompileSucceeded();
  children[0].emit('exit', 0, null); // spawn request captures B
  ready = false; signature = 'partial next build';
  children[1].emit('spawn'); // must commit captured B, not A or partial output
  signature = 'A'; ready = true; policy.onCompileSucceeded();
  assert.equal(kills, 2, 'reverting to A must restart the backend that launched B');
  policy.stopDeferredPoll();
});
