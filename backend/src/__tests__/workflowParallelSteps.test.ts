import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { normalizeSteps } from '../workflows/normalization.js';
import { nextStepGroup, openStepGroup, setStepPhase } from '../workflowRuns/execution.js';
import { runs, snapshot, subscribe, type WorkflowRunEvent, type WorkflowRun } from '../workflowRuns/state.js';
import { cancelWorkflowRun, completeWorkflowStep } from '../workflowRuns.js';
import { deserializeWorkflowRuns, flushWorkflowRunPersist, writeWorkflowRunsNow } from '../workflowRuns/persistence.js';
import { registerPersistedWorkflowRuns, resumePersistedRun } from '../recovery/workflowRunResume.js';
import { beginStepPreRun, abortStepPreRun, runStepTools } from '../workflowRuns/stepTools.js';
import { cancelStopHookGate, recordStopReceived, requestStopHookStepComplete } from '../workflowRuns/stopHookGate.js';
import { workflowStepAgentId, enqueueWorkflowStepSession, cancelWorkflowStepSessions } from '../workflowRuns/sessionSpawner.js';
import { noteSubagentStart, forgetAgentQuiescence, isAgentQuiescent, READOPTED_SETTLE_MS } from '../agentQuiescence.js';
import { workflowStepDir } from '../workflowRuns/scratchDirectory.js';
import { queueState } from '../spawnQueue/state.js';
import { SPAWN_QUEUE_CONFIG } from '../spawnQueue/config.js';
import { drainQueue } from '../spawnQueue/drain.js';
import { listAgentSessions } from '../agentSessions.js';
import { withTempDir } from './helpers/tempDir.js';
import { canonicalProjectPath } from '../projectPath.js';
import { createTask, listTasks } from '../tasks.js';

// Reviews may overlap only inside an opted-in adjacent group. Its join must
// survive out-of-order callbacks, capacity waits, cancellation and restarts.
function step(id: string, parallel = false) {
  return { id, title: id, prompt: 'Review and file tasks', harness: 'claude' as const, kind: 'agent' as const, parallel };
}

async function fixture(fn: (run: WorkflowRun) => Promise<void>, preceding = false) {
  await withTempDir('lattice-parallel-', async (dir) => {
    const projectPath = canonicalProjectPath(dir);
    const steps = preceding ? [step('before'), step('a', true), step('b', true), step('after')]
      : [step('a', true), step('b', true)];
    const run: WorkflowRun = { id: `wfrun_parallel_${Date.now()}_${Math.random()}`, workflowId: 'parallel', workflowName: 'Parallel',
      projectPath, status: 'running', startedAt: 1, currentStepIndex: 0, totalSteps: steps.length,
      definition: { id: 'parallel', name: 'Parallel', projectPath, steps, variables: [], createdAt: 1 } };
    openStepGroup(run, steps, nextStepGroup(steps, 0)!);
    for (const index of run.activeStepIndices!) setStepPhase(run, index, 'running');
    runs.set(run.id, run);
    try { await fn(run); }
    finally {
      cancelWorkflowRun(run.id);
      cancelStopHookGate(run.id);
      cancelWorkflowStepSessions(run.id, { proxyKillSession: async () => true });
      for (let i = 0; i < steps.length; i++) forgetAgentQuiescence(workflowStepAgentId(run.id, i));
      runs.delete(run.id);
      await flushWorkflowRunPersist(projectPath);
      await writeWorkflowRunsNow(projectPath, []);
    }
  });
}

test('only literal opt-in on planning steps is retained; the old mode stays inert', () => {
  const result = normalizeSteps([{ ...step('a'), parallel: true }, { ...step('b'), parallel: 'true' },
    { ...step('old'), mode: 'parallel' }, ...['start', 'merge', 'test', 'push'].map((kind) => ({ ...step(kind), kind, parallel: true }))]);
  assert.equal(result[0].parallel, true);
  assert.ok(result.slice(1).every((s) => s.parallel === undefined));
  assert.equal('mode' in result[2], false);
});

test('groups preserve unmarked/action boundaries, including frozen separators', () => {
  const steps = [step('a', true), { ...step('b', true), frozen: true }, step('c', true),
    { ...step('separator'), frozen: true }, step('d', true), step('e', true),
    { ...step('merge', true), kind: 'merge' as const }, step('f', true)];
  assert.deepEqual(nextStepGroup(steps, 0), { indices: [0, 2], end: 3 });
  assert.deepEqual(nextStepGroup(steps, 3), { indices: [4, 5], end: 6 });
  assert.deepEqual(nextStepGroup(steps, 6), { indices: [6], end: 7 });
  assert.deepEqual(nextStepGroup(steps, 7), { indices: [7], end: 8 });
});

test('out-of-order and duplicate callbacks wait for every member and dispatch the next step once', async () => {
  await fixture(async (run) => {
    const dispatched: number[] = [];
    const killed: number[] = [];
    const deps = { killStepSession: async (_id: string, i: number) => { killed.push(i); },
      dispatchStep: async (_wf: unknown, live: WorkflowRun, i: number) => { dispatched.push(i); setStepPhase(live, i, 'running'); } };
    await completeWorkflowStep(run.id, 0, '', deps);
    assert.deepEqual(dispatched, [1, 2]);
    await Promise.all([completeWorkflowStep(run.id, 2, '', deps), completeWorkflowStep(run.id, 2, '', deps)]);
    assert.deepEqual(dispatched, [1, 2]);
    assert.equal(run.stepStates![2].phase, 'completed');
    assert.equal(run.currentStepIndex, 1);
    await completeWorkflowStep(run.id, 1, '', deps);
    assert.deepEqual(dispatched, [1, 2, 3]);
    assert.deepEqual(killed, [0, 2, 1]);
    await completeWorkflowStep(run.id, 2, '', deps);
    assert.deepEqual(dispatched, [1, 2, 3]);
  }, true);
});

test('simultaneous last completions cannot cross the barrier before both teardowns', async () => {
  await fixture(async (run) => {
    let release!: () => void;
    let entered!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const first = completeWorkflowStep(run.id, 0, '', { killStepSession: async () => { entered(); await blocked; } });
    await started;
    await completeWorkflowStep(run.id, 1, '', { killStepSession: async () => {} });
    assert.equal(run.status, 'running');
    assert.equal(run.stepStates![0].phase, 'completing');
    release();
    await first;
    assert.equal(run.status, 'completed');
  });
});

test('step snapshots are deep copies and damaged group state cannot become a serial replay', async () => {
  await fixture(async (run) => {
    await recordStopReceived(run.id, 1);
    const copy = snapshot(run);
    copy.activeStepIndices!.pop();
    copy.stepStates![1].stopReceived!.at = 0;
    assert.equal(run.activeStepIndices!.length, 2);
    assert.notEqual(run.stepStates![1].stopReceived!.at, 0);
    const [loaded] = deserializeWorkflowRuns(JSON.parse(JSON.stringify({ version: 3, runs: [run] })), run.projectPath);
    assert.deepEqual(loaded.stepStates, run.stepStates);
    const broken = snapshot(run);
    delete broken.stepStates![1];
    const [invalid] = deserializeWorkflowRuns([broken]);
    assert.match(invalid.definitionError ?? '', /execution state is invalid/);
    const fractional = { ...snapshot(run), currentStepIndex: 0.5 };
    assert.match(deserializeWorkflowRuns([fractional])[0].definitionError ?? '', /execution state is invalid/);
    const missingMirror = { ...snapshot(run), stepPhase: undefined, stepSessionId: undefined };
    assert.equal(deserializeWorkflowRuns([missingMirror])[0].stepPhase, 'running');
  });
});

test('restart adopts all surviving members and does not replay completed reviews', async () => {
  await fixture(async (run) => {
    setStepPhase(run, 0, 'completed');
    const saved = snapshot(run);
    runs.delete(run.id);
    registerPersistedWorkflowRuns([saved], [{ id: 'survivor', cwd: workflowStepDir(run.projectPath, run.id, 1) }]);
    await resumePersistedRun(saved, [{ id: 'survivor', cwd: workflowStepDir(run.projectPath, run.id, 1) }], '', true);
    assert.equal(runs.get(run.id)!.stepStates![0].phase, 'completed');
    assert.ok(listAgentSessions(run.projectPath).some((s) => s.agentId === workflowStepAgentId(run.id, 1)));
    await completeWorkflowStep(run.id, 1, '', { killStepSession: async () => {} });
    assert.equal(runs.get(run.id)!.status, 'completed');
  });
});

test('restart finishes a durably completed group without a live terminal or prompt replay', async () => {
  await fixture(async (run) => {
    setStepPhase(run, 0, 'completed');
    setStepPhase(run, 1, 'completed');
    const saved = snapshot(run);
    runs.delete(run.id);
    await resumePersistedRun(saved, [], '');
    assert.equal(runs.get(run.id)!.status, 'completed');
  });
});

test('restart redispatches only a pending member while readopting its surviving sibling', async () => {
  await fixture(async (run) => {
    setStepPhase(run, 1, 'pending');
    const saved = snapshot(run);
    const sessions = [{ id: 'already-running', cwd: workflowStepDir(run.projectPath, run.id, 0) }];
    const dispatched: number[] = [];
    runs.delete(run.id);
    try {
      registerPersistedWorkflowRuns([saved], sessions);
      await resumePersistedRun(saved, sessions, 'http://127.0.0.1:1', true,
        { redispatchStep: async (_id, _origin, index) => { dispatched.push(index!); } });
      assert.equal(runs.get(run.id)!.stepStates![0].phase, 'running');
      assert.equal(runs.get(run.id)!.stepStates![1].phase, 'pending');
      assert.deepEqual(dispatched, [1]);
    } finally {
      cancelWorkflowStepSessions(run.id, { proxyKillSession: async () => true });
    }
  });
});

test('restart re-adopts admitted members from spawning checkpoints and restores their running status', async () => {
  await fixture(async (run) => {
    for (const i of [0, 1]) setStepPhase(run, i, 'spawning');
    const saved = snapshot(run);
    const sessions = [0, 1].map((i) => ({ id: `admitted-${i}`, cwd: workflowStepDir(run.projectPath, run.id, i) }));
    runs.delete(run.id);
    try {
      registerPersistedWorkflowRuns([saved], sessions);
      await resumePersistedRun(saved, sessions, '', true);
      assert.deepEqual(Object.values(runs.get(run.id)!.stepStates!).map((s) => [s.phase, s.sessionId]),
        [['running', 'admitted-0'], ['running', 'admitted-1']]);
    } finally {
      cancelWorkflowStepSessions(run.id, { proxyKillSession: async () => true });
    }
  });
});

test('every held Stop survives restart with its own quiet or busy recovery window', async () => {
  await fixture(async (run) => {
    await Promise.all([recordStopReceived(run.id, 0), recordStopReceived(run.id, 1)]);
    for (const i of [0, 1]) run.stepStates![i].stopReceived!.at = Date.now() - READOPTED_SETTLE_MS - 5_000;
    run.stepStates![1].stopReceived!.busy = true;
    const [saved] = deserializeWorkflowRuns(JSON.parse(JSON.stringify([run])));
    const sessions = [0, 1].map((i) => ({ id: `held-${i}`, cwd: workflowStepDir(run.projectPath, run.id, i) }));
    runs.delete(run.id);
    try {
      registerPersistedWorkflowRuns([saved], sessions);
      await resumePersistedRun(saved, sessions, '', true);
      assert.ok(isAgentQuiescent(workflowStepAgentId(run.id, 0), 4_000));
      assert.ok(!isAgentQuiescent(workflowStepAgentId(run.id, 1), 4_000));
      assert.equal(runs.get(run.id)!.stepStates![1].stopReceived!.busy, true);
    } finally {
      cancelStopHookGate(run.id);
      cancelWorkflowStepSessions(run.id, { proxyKillSession: async () => true });
    }
  });
});

test('a lost member errors the group while an unavailable probe preserves surviving work', async () => {
  await fixture(async (run) => {
    const saved = snapshot(run);
    runs.delete(run.id);
    await resumePersistedRun(saved, null, '');
    assert.equal(runs.get(run.id)!.status, 'running');
    const restored = snapshot(runs.get(run.id)!);
    cancelStopHookGate(run.id);
    cancelWorkflowStepSessions(run.id, { proxyKillSession: async () => true });
    runs.delete(run.id);
    await resumePersistedRun(restored, [], '');
    assert.equal(runs.get(run.id)!.status, 'errored');
    assert.ok(Object.values(runs.get(run.id)!.stepStates!).some((s) => s.phase === 'errored'));
  });
});

test('each member has an independent Stop gate and cancellation clears them all', async () => {
  await fixture(async (run) => {
    let completed = 0;
    noteSubagentStart(workflowStepAgentId(run.id, 0));
    requestStopHookStepComplete(run.id, 0, () => { throw new Error('busy member must not finish'); }, { settleMs: 2, pollMs: 2 });
    requestStopHookStepComplete(run.id, 1, () => { completed++; }, { settleMs: 2, pollMs: 2 });
    await delay(40);
    assert.equal(completed, 1);
    cancelWorkflowRun(run.id);
    await delay(10);
  });
});

test('cancellation reaches all queued members and every pre-run controller', async () => {
  await fixture(async (run) => {
    queueState.accounting.setSoftCap(1);
    queueState.accounting.reconcile(1, Date.now());
    const signals = [beginStepPreRun(run.id, 0), beginStepPreRun(run.id, 1)];
    assert.ok(signals.every((s) => !s.aborted));
    let spawned = 0;
    const pending = [0, 1].map((index) => enqueueWorkflowStepSession({ run, stepIndex: index, projectPath: run.projectPath,
      stepDir: workflowStepDir(run.projectPath, run.id, index), command: 'fake', harness: 'claude',
      deps: { proxyCreateSession: async () => { spawned++; return { id: 'unexpected' }; } } }));
    try {
      cancelWorkflowRun(run.id);
      const settled = await Promise.allSettled(pending);
      assert.ok(settled.every((s) => s.status === 'rejected'));
      assert.ok(signals.every((s) => s.aborted));
      assert.equal(spawned, 0);
      assert.equal(abortStepPreRun(run.id), false);
      await completeWorkflowStep(run.id, 1, '');
      assert.equal(run.status, 'cancelled');
    } finally {
      queueState.accounting.setSoftCap(SPAWN_QUEUE_CONFIG.softCap);
      queueState.accounting.reconcile(0, Date.now() + 1);
    }
  });
});

test('capacity can defer a member without letting its completed sibling advance the group', async () => {
  await fixture(async (run) => {
    queueState.accounting.setSoftCap(1);
    queueState.accounting.reconcile(0, Date.now() + 1);
    const spawned: number[] = [];
    const killed: string[] = [];
    for (const i of [0, 1]) setStepPhase(run, i, 'pending');
    const enqueue = (index: number) => enqueueWorkflowStepSession({ run, stepIndex: index, projectPath: run.projectPath,
      stepDir: workflowStepDir(run.projectPath, run.id, index), command: 'fake', harness: 'claude',
      deps: { proxyCreateSession: async () => { spawned.push(index); return { id: `tty-${index}` }; },
        proxyKillSession: async (id) => { killed.push(id); return false; } } });
    try {
      await enqueue(0);
      const waiting = enqueue(1);
      assert.equal(run.stepStates![0].sessionId, 'tty-0');
      assert.equal(run.stepStates![1].phase, 'pending');
      await completeWorkflowStep(run.id, 0, '');
      assert.deepEqual(spawned, [0]);
      assert.equal(run.status, 'running');
      assert.equal(run.stepStates![0].phase, 'completed');
      queueState.accounting.reconcile(0, Date.now() + 1);
      drainQueue();
      await waiting;
      assert.deepEqual(spawned, [0, 1]);
      assert.equal(run.stepStates![1].sessionId, 'tty-1');
      await completeWorkflowStep(run.id, 1, '');
      assert.equal(run.status, 'completed');
      assert.deepEqual(killed, ['tty-0', 'tty-1']);
    } finally {
      queueState.accounting.setSoftCap(SPAWN_QUEUE_CONFIG.softCap);
      queueState.accounting.reconcile(0, Date.now() + 1);
    }
  });
});

test('a failed member kills a running sibling, aborts its pre-run and preserves the failed member', async () => {
  await fixture(async (run) => {
    queueState.accounting.setSoftCap(2);
    queueState.accounting.reconcile(0, Date.now() + 1);
    const killed: string[] = [];
    const scan = beginStepPreRun(run.id, 0);
    const deps = { proxyKillSession: async (id: string) => { killed.push(id); return true; } };
    try {
      await enqueueWorkflowStepSession({ run, stepIndex: 0, projectPath: run.projectPath,
        stepDir: workflowStepDir(run.projectPath, run.id, 0), command: 'fake', harness: 'claude',
        deps: { ...deps, proxyCreateSession: async () => ({ id: 'running-sibling' }) } });
      await assert.rejects(enqueueWorkflowStepSession({ run, stepIndex: 1, projectPath: run.projectPath,
        stepDir: workflowStepDir(run.projectPath, run.id, 1), command: 'fake', harness: 'claude',
        deps: { ...deps, proxyCreateSession: async () => { throw new Error('failed member'); } } }), /failed member/);
      assert.equal(run.status, 'errored');
      assert.equal(run.stepStates![0].phase, 'cancelled');
      assert.equal(run.stepStates![1].phase, 'errored');
      assert.ok(scan.aborted);
      assert.deepEqual(killed, ['running-sibling']);
      assert.ok(!listAgentSessions(run.projectPath).some((s) => s.agentId.startsWith(`wf:${run.id}:`)));
    } finally {
      queueState.accounting.setSoftCap(SPAWN_QUEUE_CONFIG.softCap);
      queueState.accounting.reconcile(0, Date.now() + 1);
    }
  });
});

test('cancelling simultaneous in-flight allocations kills late terminals and emits no tabs', async () => {
  await fixture(async (run) => {
    queueState.accounting.setSoftCap(2);
    queueState.accounting.reconcile(0, Date.now() + 1);
    let release!: () => void;
    let entered!: () => void;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    const bothEntered = new Promise<void>((resolve) => { entered = resolve; });
    let allocations = 0;
    const killed: string[] = [];
    const events: WorkflowRunEvent[] = [];
    const unsubscribe = subscribe((ev) => { if (ev.type === 'step-spawned' && ev.runId === run.id) events.push(ev); });
    const waiting = [0, 1].map((index) => enqueueWorkflowStepSession({ run, stepIndex: index, projectPath: run.projectPath,
      stepDir: workflowStepDir(run.projectPath, run.id, index), command: 'fake', harness: 'claude',
      deps: { proxyCreateSession: async () => { if (++allocations === 2) entered(); await hold; return { id: `late-${index}` }; },
        proxyKillSession: async (id) => { killed.push(id); return true; } } }));
    try {
      await bothEntered;
      cancelWorkflowRun(run.id);
      release();
      assert.ok((await Promise.allSettled(waiting)).every((s) => s.status === 'rejected'));
      assert.deepEqual(killed.sort(), ['late-0', 'late-1']);
      assert.deepEqual(events, []);
      assert.equal(run.status, 'cancelled');
    } finally {
      release();
      await Promise.allSettled(waiting);
      unsubscribe();
      queueState.accounting.setSoftCap(SPAWN_QUEUE_CONFIG.softCap);
      queueState.accounting.reconcile(0, Date.now() + 1);
    }
  });
});

test('concurrent board creation retains every review ticket', async () => {
  await fixture(async (run) => {
    await Promise.all(Array.from({ length: 12 }, (_, i) => createTask(run.projectPath, `Review ${i}`)));
    assert.equal((await listTasks(run.projectPath)).length, 12);
  });
});

test('parallel pre-scans serialize without aborting their sibling', async () => {
  await fixture(async (run) => {
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const hold = new Promise<void>((resolve) => { release = resolve; });
    const seen: number[] = [];
    const a = runStepTools({ tools: ['opengrep'] }, run.projectPath, run.projectPath, { scan: async () => {
      seen.push(0); entered(); await hold; throw new Error('fake scan finished');
    } }, beginStepPreRun(run.id, 0));
    await started;
    const b = runStepTools({ tools: ['opengrep'] }, run.projectPath, run.projectPath, { scan: async () => {
      seen.push(1); throw new Error('fake scan finished');
    } }, beginStepPreRun(run.id, 1));
    await delay(10);
    assert.deepEqual(seen, [0]);
    release();
    await Promise.all([a, b]);
    assert.deepEqual(seen, [0, 1]);
  });
});
