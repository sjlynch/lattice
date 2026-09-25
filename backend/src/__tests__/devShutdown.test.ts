// The dev runner's stop sequence (scripts/dev/devShutdown.mjs): the dev
// console's soft stop (`r` / `d`) must drain the backend through the restart
// handshake BEFORE killing dist/index.js — the kill is TerminateProcess on
// Windows, so debounced task / run-mirror writes not flushed by the drain are
// lost. A real stop (Ctrl+C) never drains, and cuts a soft stop's drain short.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDevShutdown } from '../../scripts/dev/devShutdown.mjs';
import type { PrepareResult } from '../../scripts/dev/restartHandshake.mjs';

function fixture({
  prepare = async (): Promise<PrepareResult> => ({ ok: true, ready: true, pending: [], waitedMs: 3 }),
  backendRunning = true,
}: { prepare?: (reason: string) => Promise<PrepareResult>; backendRunning?: boolean } = {}) {
  const calls: string[] = [];
  const logs: string[] = [];
  const shutdown = createDevShutdown({
    stopWatchers: () => { calls.push('stopWatchers'); },
    stopCompiler: () => { calls.push('stopCompiler'); },
    shutdownTerminals: async () => { calls.push('shutdownTerminals'); },
    prepareDrain: async (reason) => {
      calls.push(`prepare:${reason}`);
      return prepare(reason);
    },
    killBackend: (signal) => { calls.push(`kill:${signal}`); },
    needsBackendStart: () => !backendRunning,
    onNoBackend: () => { calls.push('onNoBackend'); },
    log: (msg) => logs.push(msg),
    warn: (msg) => logs.push(msg),
  });
  return { shutdown, calls, logs };
}

test('soft stop drains the backend before killing it, and keeps the terminal-server', async () => {
  const f = fixture();
  await f.shutdown.shutdown('SIGTERM', { keepTerminals: true });
  assert.deepEqual(f.calls, ['stopWatchers', 'stopCompiler', 'prepare:soft stop', 'kill:SIGTERM']);
  assert.ok(f.logs.some((l) => l.includes('drained for the soft stop')));
});

test('soft stop waits for the drain to answer before the kill', async () => {
  let answer!: (r: PrepareResult) => void;
  const f = fixture({ prepare: () => new Promise((resolve) => { answer = resolve; }) });
  const done = f.shutdown.shutdown('SIGTERM', { keepTerminals: true });
  await new Promise((r) => setImmediate(r));
  assert.ok(f.calls.includes('prepare:soft stop'));
  assert.ok(!f.calls.includes('kill:SIGTERM'), 'must not kill while the backend is still draining');
  answer({ ok: true, ready: false, pending: ['workflow advance'], waitedMs: 10_000 });
  await done;
  assert.equal(f.calls.at(-1), 'kill:SIGTERM');
  assert.ok(f.logs.some((l) => l.includes('workflow advance')));
});

test('soft stop fails open when the handshake is unavailable or throws', async () => {
  const unavailable = fixture({ prepare: async () => ({ ok: false, why: 'backend unreachable: ECONNREFUSED' }) });
  await unavailable.shutdown.shutdown('SIGTERM', { keepTerminals: true });
  assert.equal(unavailable.calls.at(-1), 'kill:SIGTERM');
  assert.ok(unavailable.logs.some((l) => l.includes('ECONNREFUSED')));

  const throwing = fixture({ prepare: async () => { throw new Error('boom'); } });
  await throwing.shutdown.shutdown('SIGTERM', { keepTerminals: true });
  assert.equal(throwing.calls.at(-1), 'kill:SIGTERM');
});

test('soft stop with no backend running skips the drain', async () => {
  const f = fixture({ backendRunning: false });
  await f.shutdown.shutdown('SIGTERM', { keepTerminals: true });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(f.calls, ['stopWatchers', 'stopCompiler', 'kill:SIGTERM', 'onNoBackend']);
});

test('a real stop never drains and shuts the terminal-server down', async () => {
  const f = fixture();
  await f.shutdown.shutdown('SIGINT');
  assert.ok(!f.calls.some((c) => c.startsWith('prepare:')));
  assert.ok(f.calls.includes('shutdownTerminals'));
  assert.equal(f.calls.at(-1), 'kill:SIGINT');
});

test('a real stop during a soft stop drain kills at once and still sends /shutdown', async () => {
  const f = fixture({ prepare: () => new Promise(() => { /* never answers */ }) });
  const soft = f.shutdown.shutdown('SIGTERM', { keepTerminals: true });
  const hard = f.shutdown.shutdown('SIGINT');
  assert.equal(soft, hard, 'one shared in-flight stop');
  await hard;
  assert.ok(f.calls.includes('shutdownTerminals'));
  assert.equal(f.calls.filter((c) => c.startsWith('kill:')).length, 1);
  assert.ok(f.calls.indexOf('prepare:soft stop') < f.calls.indexOf('kill:SIGTERM'));
});
