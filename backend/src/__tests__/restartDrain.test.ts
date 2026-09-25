// The backend half of the dev-runner restart handshake (restartDrain/,
// routes/restartDrain.ts): the drain gate + its TTL, the transition tracker,
// the settle wait, the lock-holder report, the gates it puts on the spawn
// queue / run lock / control-step hand-off, and the internal route's auth.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import {
  beginRestartDrain,
  beginRestartTransition,
  endRestartDrain,
  getRestartDrainState,
  isRestartDraining,
  onRestartDrainEnded,
  pendingRestartTransitions,
  resetRestartDrainForTests,
  trackRestartTransition,
  waitWhileRestartDraining,
} from '../restartDrain/gate.js';
import { settleForRestart, RESTART_SETTLE_QUIET_POLLS } from '../restartDrain/settle.js';
import { describeLockHolders, type LockHolderDeps } from '../restartDrain/lockHolders.js';
import { buildRestartDrainAdmissionGate, buildRestartDrainRouter } from '../routes/restartDrain.js';
import { getTerminalServerAuthToken, TERMINAL_SERVER_AUTH_HEADER } from '../terminalServerAuth.js';
import { acquireProjectRunLock } from '../projectRunLock.js';
import { queueState } from '../spawnQueue/state.js';
import { drainQueue } from '../spawnQueue/drain.js';
import '../spawnQueue.js'; // registers the drain-ended → re-drain listener
import { runControlStepWorker } from '../workflowRuns/controlStep.js';
import type { WorkflowRun } from '../workflowRuns/state.js';
import type { Workflow } from '../workflows.js';
import { projectHash } from '../projectPath.js';
import type { MergeRun } from '../mergeRuns/types.js';

const tick = () => new Promise((r) => setImmediate(r));

test('drain: begin/extend/end, waiters and listeners wake on end', async (t) => {
  resetRestartDrainForTests();
  t.after(resetRestartDrainForTests);
  const ended: string[] = [];
  t.after(onRestartDrainEnded((why) => { ended.push(why); }));
  assert.equal(isRestartDraining(), false);
  await waitWhileRestartDraining(); // resolves at once when not draining

  beginRestartDrain('test', 60_000);
  assert.equal(isRestartDraining(), true);
  const until = getRestartDrainState().until!;
  beginRestartDrain('test again', 1_000); // shorter: never shortens
  assert.equal(getRestartDrainState().until, until);

  let woke = false;
  const waiting = waitWhileRestartDraining().then(() => { woke = true; });
  await tick();
  assert.equal(woke, false, 'held while draining');
  assert.equal(endRestartDrain('cancelled'), true);
  await waiting;
  assert.equal(woke, true);
  assert.deepEqual(ended, ['cancelled']);
  assert.equal(endRestartDrain('again'), false, 'ending twice is a no-op');
});

test('drain: the TTL ends a drain nobody follows up on', async (t) => {
  resetRestartDrainForTests();
  t.after(resetRestartDrainForTests);
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const ended: string[] = [];
  t.after(onRestartDrainEnded((why) => { ended.push(why); }));
  beginRestartDrain('orphaned', 5_000);
  t.mock.timers.tick(4_999);
  assert.equal(isRestartDraining(), true);
  t.mock.timers.tick(2);
  assert.equal(isRestartDraining(), false);
  assert.deepEqual(ended, ['ttl expired without a restart']);
});

test('transition tracker lists what is in flight and forgets settled work', async (t) => {
  resetRestartDrainForTests();
  t.after(resetRestartDrainForTests);
  const end = beginRestartTransition('advance A');
  let settle!: () => void;
  const work = trackRestartTransition('create B', new Promise<void>((r) => { settle = r; }));
  assert.deepEqual(pendingRestartTransitions().map((s) => s.replace(/ \(.*\)$/, '')), ['advance A', 'create B']);
  end();
  end(); // idempotent
  settle();
  await work;
  assert.deepEqual(pendingRestartTransitions(), []);
  // A rejected transition is forgotten too.
  await trackRestartTransition('failing', Promise.reject(new Error('x'))).catch(() => undefined);
  assert.deepEqual(pendingRestartTransitions(), []);
});

test('settleForRestart waits for quiet, flushes, and fails open at the budget', async () => {
  let clock = 0;
  let pending = ['advance', 'create'];
  const flushed: number[] = [];
  const deps = {
    pending: () => [...pending],
    flush: async () => { flushed.push(clock); },
    now: () => clock,
    sleep: async (ms: number) => {
      clock += ms;
      if (clock >= 300) pending = [];
    },
  };
  const ok = await settleForRestart(10_000, deps);
  assert.equal(ok.ready, true);
  assert.deepEqual(ok.pending, []);
  assert.ok(ok.waitedMs >= 300, `waited for the work: ${ok.waitedMs}`);
  assert.equal(flushed.length, 1);

  clock = 0;
  pending = ['stuck worktree checkout'];
  const stuck = await settleForRestart(1_000, { ...deps, sleep: async (ms) => { clock += ms; } });
  assert.equal(stuck.ready, false);
  assert.deepEqual(stuck.pending, ['stuck worktree checkout']);
  assert.equal(flushed.length, 2, 'a fail-open restart still flushes');

  // One quiet sample is not enough: a transition can hand over to the next.
  clock = 0;
  let samples = 0;
  const flicker = await settleForRestart(10_000, {
    ...deps,
    pending: () => (++samples === 2 ? ['next step dispatch'] : []),
    sleep: async (ms) => { clock += ms; },
  });
  assert.equal(flicker.ready, true);
  assert.ok(samples >= RESTART_SETTLE_QUIET_POLLS + 2, `kept sampling past the flicker (${samples})`);
});

test('the spawn queue admits nothing while draining and re-drains when it ends', async (t) => {
  resetRestartDrainForTests();
  t.after(resetRestartDrainForTests);
  queueState.accounting.reconcile(0, Date.now()); // healthy, empty
  let ran = 0;
  beginRestartDrain('test', 60_000);
  const { request } = queueState.addOrGet({
    kind: 'test',
    priority: 'priority',
    dedupeKey: `restart-drain-test-${Date.now()}`,
    thunk: async () => { ran += 1; },
  });
  drainQueue();
  await tick();
  assert.equal(ran, 0, 'held while draining');
  assert.equal(request.state, 'pending');
  endRestartDrain('cancelled');
  await request.done;
  assert.equal(ran, 1, 'admitted as soon as the drain ended');
});

test('acquireProjectRunLock waits while draining (a run the restart would kill never starts)', async (t) => {
  resetRestartDrainForTests();
  t.after(resetRestartDrainForTests);
  const project = path.join(os.tmpdir(), `lattice-drain-lock-${process.pid}-${Date.now()}`);
  beginRestartDrain('test', 60_000);
  let acquired = false;
  const pendingLock = acquireProjectRunLock(project, 'merge-run').then((h) => { acquired = true; return h; });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(acquired, false);
  endRestartDrain('cancelled');
  const handle = await pendingLock;
  assert.equal(acquired, true);
  await handle.release();
});

test('a control step marks its lock hand-off as a transition until the advance returns', async (t) => {
  resetRestartDrainForTests();
  t.after(resetRestartDrainForTests);
  const run = {
    id: 'run_drain', workflowId: 'wf', projectPath: os.tmpdir(), status: 'running',
    currentStepIndex: 0, totalSteps: 2, startedAt: Date.now(),
  } as unknown as WorkflowRun;
  const wf = { projectPath: os.tmpdir(), steps: [{ kind: 'start' }, { kind: 'push' }] } as Workflow;
  let duringRelease: string[] = [];
  let duringAdvance: string[] = [];
  let duringWorker: string[] = [];
  await runControlStepWorker(
    wf, run, 0, 'http://127.0.0.1:5184',
    async () => { duringAdvance = pendingRestartTransitions(); },
    {
      acquireLock: async () => ({ release: async () => { duringRelease = pendingRestartTransitions(); } }),
      runStart: async () => { duringWorker = pendingRestartTransitions(); },
      runMerge: async () => undefined,
      runPush: async () => undefined,
    },
  );
  assert.deepEqual(duringWorker, [], 'the long-running worker itself is not a transition');
  assert.match(duringRelease.join(), /control step 0 \(start\) hand-off/);
  assert.match(duringAdvance.join(), /hand-off/, 'still covered while the advance runs');
  assert.deepEqual(pendingRestartTransitions(), [], 'cleared once the advance returned');
});

// ---- lock-holder report ------------------------------------------------------

function mergeRun(projectPath: string, resolvers: Record<string, string> = {}): MergeRun {
  return {
    id: 'mr_1', projectPath, status: 'running',
    resolvers: Object.fromEntries(Object.entries(resolvers).map(([k, v]) => [k, { sessionId: v, lastProgressAt: 0 }])),
  } as unknown as MergeRun;
}

function holderDeps(over: Partial<LockHolderDeps>): LockHolderDeps {
  return {
    listLiveMergeRuns: () => [],
    activeHookForProject: () => null,
    knownProjects: async () => [],
    listSessions: async () => [],
    ...over,
  };
}

test('lock holders: a run parked on a live resolver / hook is reported parked; a dead pty is not', async () => {
  const a = path.join(os.tmpdir(), 'lattice-holders-a');
  const b = path.join(os.tmpdir(), 'lattice-holders-b');
  const c = path.join(os.tmpdir(), 'lattice-holders-c');
  const reports = await describeLockHolders(holderDeps({
    listLiveMergeRuns: () => [
      { run: mergeRun(a, { t1: 'pty-live' }), resolverTaskIds: ['t1'] },
      { run: mergeRun(b, { t2: 'pty-dead' }), resolverTaskIds: ['t2'] },
      { run: mergeRun(c), resolverTaskIds: [] },
    ],
    activeHookForProject: (p) => (p === path.resolve(c) ? { id: 'pmh_1', serverId: 'pty-hook' } : null),
    listSessions: async () => [{ id: 'pty-live' }, { id: 'pty-hook' }],
  }));
  const byHash = new Map(reports.map((r) => [r.hash, r]));
  assert.equal(byHash.get(projectHash(a))?.parkedOn, 'conflict-resolver');
  assert.equal(byHash.get(projectHash(b))?.parkedOn, null, 'a resolver whose pty is gone is not "parked on a live agent"');
  assert.match(byHash.get(projectHash(b))?.detail ?? '', /is gone/);
  assert.equal(byHash.get(projectHash(c))?.parkedOn, 'post-merge-hook');
});

test('lock holders: "can\'t tell" (terminal-server unreachable) counts as alive, never as gone', async () => {
  const a = path.join(os.tmpdir(), 'lattice-holders-unknown');
  const [report] = await describeLockHolders(holderDeps({
    listLiveMergeRuns: () => [{ run: mergeRun(a, { t1: 'pty-x' }), resolverTaskIds: ['t1'] }],
    listSessions: async () => null,
  }));
  assert.equal(report.parkedOn, 'conflict-resolver');
  assert.match(report.detail, /liveness unknown/);
});

// ---- HTTP: auth + admission gate ---------------------------------------------

async function withApp(fn: (base: string) => Promise<void>): Promise<void> {
  const app = express();
  app.use(express.json());
  app.use(buildRestartDrainAdmissionGate());
  app.use(buildRestartDrainRouter());
  app.post('/api/merge-runs', (_req, res) => { res.json({ started: true }); });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  try {
    await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

test('the handshake route refuses browsers and callers without the backend token', async (t) => {
  resetRestartDrainForTests();
  t.after(resetRestartDrainForTests);
  assert.ok(process.env.LATTICE_TEST_HOME_ISOLATED, 'run via the isolated-home test harness');
  const token = getTerminalServerAuthToken();
  await withApp(async (base) => {
    const url = `${base}/api/internal/restart-drain/prepare`;
    const noToken = await fetch(url, { method: 'POST' });
    assert.equal(noToken.status, 401);
    const browser = await fetch(url, {
      method: 'POST',
      headers: { [TERMINAL_SERVER_AUTH_HEADER]: token, origin: 'http://localhost:5183' },
    });
    assert.equal(browser.status, 403, 'even the Lattice UI origin cannot drive it');
    assert.equal(isRestartDraining(), false, 'a refused request changed nothing');

    const ok = await fetch(url, {
      method: 'POST',
      headers: { [TERMINAL_SERVER_AUTH_HEADER]: token, 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'test', ttlMs: 60_000, budgetMs: 2_000 }),
    });
    assert.equal(ok.status, 200);
    const body = await ok.json() as { ready: boolean; pid: number; drain: { draining: boolean } };
    assert.equal(body.ready, true);
    assert.equal(body.pid, process.pid);
    assert.equal(body.drain.draining, true);

    // While draining, a new top-level run is refused with a retryable 503.
    const refused = await fetch(`${base}/api/merge-runs`, { method: 'POST' });
    assert.equal(refused.status, 503);
    assert.ok(refused.headers.get('retry-after'));
    assert.equal(((await refused.json()) as { code: string }).code, 'backend-restarting');

    const cancel = await fetch(`${base}/api/internal/restart-drain/cancel`, {
      method: 'POST', headers: { [TERMINAL_SERVER_AUTH_HEADER]: token },
    });
    assert.deepEqual(await cancel.json(), { ended: true });
    assert.equal(isRestartDraining(), false);
    const admitted = await fetch(`${base}/api/merge-runs`, { method: 'POST' });
    assert.equal(admitted.status, 200);
  });
});
