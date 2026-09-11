import { test } from 'node:test';
import assert from 'node:assert/strict';
import { queuedCreateSession } from '../queuedCreateSession.js';
import { queueState } from '../spawnQueue/state.js';
import { SPAWN_QUEUE_CONFIG } from '../spawnQueue/config.js';
import { drainQueue } from '../spawnQueue/drain.js';
import { createRunState } from '../mergeRuns/state.js';
import { mergeRunCancellation } from '../mergeRuns/cancellation.js';
import type { MergeRun } from '../mergeRuns/types.js';

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
function reset() { queueState.accounting.setSoftCap(SPAWN_QUEUE_CONFIG.softCap); queueState.accounting.reconcile(0, Date.now() + 1); }
function block() { queueState.accounting.setSoftCap(1); queueState.accounting.reconcile(1 + SPAWN_QUEUE_CONFIG.priorityReserve, Date.now() + 1); }
function args(signal?: AbortSignal) { return { kind: 'test-resolver', priority: 'priority' as const,
  dedupeKey: `cancel-test-${Date.now()}`, opts: { cwd: '/fixture' }, signal }; }

test('cancelling a capacity-blocked resolver removes it permanently before releasing its caller', async () => {
  block();
  const state = createRunState();
  const run: MergeRun = { id: 'cancel-run', projectPath: '/fixture', status: 'running', startedAt: 1,
    total: 1, processed: 0, merged: [], conflicted: [], errored: [], cancelRequested: false };
  state.runs.set(run.id, run);
  state.markRunLive(run.id);
  let created = 0;
  const input = args(mergeRunCancellation(run));
  const done = queuedCreateSession(input, { proxyCreateSession: async () => { created++; return { id: 'never' }; }, proxyKillSession: async () => true });
  try {
    assert.ok(queueState.get(input.dedupeKey));
    state.cancelRun(run.id);
    await assert.rejects(done, /cancelled/);
    assert.equal(queueState.get(input.dedupeKey), undefined);
    reset(); drainQueue(); await pause(5);
    assert.equal(created, 0);
  } finally { reset(); }
});

test('an in-flight cancellation waits for terminal creation and confirmed cleanup', async () => {
  reset();
  const controller = new AbortController();
  let completeCreate!: (value: { id: string }) => void;
  let completeKill!: (value: boolean) => void;
  const created = new Promise<{ id: string }>((resolve) => { completeCreate = resolve; });
  const killed = new Promise<boolean>((resolve) => { completeKill = resolve; });
  const killedIds: string[] = [];
  let settled = false;
  const done = queuedCreateSession(args(controller.signal), { proxyCreateSession: () => created,
    proxyKillSession: async (id) => { killedIds.push(id); return killed; } });
  const observed = done.finally(() => { settled = true; });
  const rejection = assert.rejects(observed, /cancelled/);
  try {
    controller.abort(new Error('cancelled'));
    await pause(5); assert.equal(settled, false);
    completeCreate({ id: 'late-worker' });
    await pause(5); assert.equal(settled, false);
    assert.deepEqual(killedIds, ['late-worker']);
    completeKill(true);
    await rejection;
  } finally { completeCreate({ id: 'late-worker' }); completeKill(true); await rejection; reset(); }
});

test('capacity timeout cancels the queued request and never admits it later', async () => {
  block();
  let created = 0;
  const input = { ...args(), timeoutMs: 5 };
  try {
    await Promise.all([
      assert.rejects(queuedCreateSession(input, { proxyCreateSession: async () => { created++; return { id: 'never' }; }, proxyKillSession: async () => true }), /admission timed out/),
      pause(15),
    ]);
    assert.equal(queueState.get(input.dedupeKey), undefined);
    reset(); drainQueue(); await pause(5);
    assert.equal(created, 0);
  } finally { reset(); }
});

test('cancellation racing a terminal CAP response cannot requeue a cancelled request', async () => {
  reset();
  const controller = new AbortController();
  const input = args(controller.signal);
  try {
    await assert.rejects(queuedCreateSession(input, {
      proxyCreateSession: async () => { controller.abort(new Error('cancelled')); return { error: 'full', code: 'CAP' }; },
      proxyKillSession: async () => true,
    }), /cancelled/);
    assert.equal(queueState.get(input.dedupeKey), undefined);
  } finally { reset(); }
});

for (const throws of [false, true]) {
  test(`an unconfirmed terminal stop retains its session identity (${throws ? 'throw' : 'false'})`, async () => {
    reset();
    const controller = new AbortController();
    try {
      await assert.rejects(queuedCreateSession(args(controller.signal), {
        proxyCreateSession: async () => { controller.abort(new Error('cancelled')); return { id: 'uncertain-session' }; },
        proxyKillSession: async () => { if (throws) throw new Error('connection refused'); return false; },
      }), /uncertain-session could not be confirmed stopped/);
    } finally { reset(); }
  });
}
