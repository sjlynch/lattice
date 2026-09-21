import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { once } from 'node:events';
import { canonicalProjectPath } from '../projectPath.js';
import { runs, snapshot, type WorkflowRun } from '../workflowRuns/state.js';
import { completeWorkflowStep, restoreWorkflowRun } from '../workflowRuns.js';
import { registerPersistedWorkflowRuns, resumePersistedRun } from '../recovery/workflowRunResume.js';
import { buildWorkflowRunsRouter } from '../routes/workflows/runs.js';
import { beginWorkflowRecovery, waitForWorkflowRecovery } from '../workflowRuns/recoveryReadiness.js';
import { deserializeWorkflowRuns, loadPersistedWorkflowRuns, flushWorkflowRunPersist, writeWorkflowRunsNow } from '../workflowRuns/persistence.js';
import { classifyWorkflowRunResume, findStepSessionId } from '../workflowRuns/resumeDecision.js';
import { enqueueWorkflowStepSession, cancelWorkflowStepSessions } from '../workflowRuns/sessionSpawner.js';
import { queueState } from '../spawnQueue/state.js';

async function fixture() {
  const projectPath = canonicalProjectPath(await fs.mkdtemp(path.join(os.tmpdir(), 'lattice-durable-')));
  const run: WorkflowRun = {
    id: `wfrun_durable_${Date.now()}`, workflowId: 'frozen', workflowName: 'Frozen', projectPath,
    status: 'running', startedAt: Date.now(), currentStepIndex: 0, totalSteps: 1, stepPhase: 'running',
    definition: { id: 'frozen', name: 'Frozen', projectPath, createdAt: 1, variables: [], steps: [
      { id: 'original-step', title: 'Original', prompt: 'original prompt', mode: 'sequential', harness: 'claude' },
    ] },
  };
  return { run, cleanup: async () => {
    run.status = 'cancelled';
    cancelWorkflowStepSessions(run.id, { proxyKillSession: async () => true });
    runs.delete(run.id);
    await flushWorkflowRunPersist(projectPath);
    await writeWorkflowRunsNow(projectPath, []);
    await fs.rm(projectPath, { recursive: true, force: true });
  } };
}

test('completion arriving during persisted-run loading waits for recovery instead of being lost', async () => {
  const { run, cleanup } = await fixture();
  const finish = beginWorkflowRecovery();
  const app = express();
  app.use(buildWorkflowRunsRouter('http://127.0.0.1:1'));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address() as { port: number };
  try {
    await writeWorkflowRunsNow(run.projectPath, [run]);
    let replied = false;
    const response = fetch(`http://127.0.0.1:${address.port}/api/workflow-runs/${run.id}/steps/0/complete`, { method: 'POST' })
      .then((res) => { replied = true; return res; });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(replied, false, 'callback must not acknowledge an unknown run during load');
    const [loaded] = await loadPersistedWorkflowRuns(run.projectPath);
    restoreWorkflowRun(loaded);
    finish();
    assert.equal((await response).status, 200);
    assert.equal(runs.get(run.id)?.status, 'completed');
    const missing = await fetch(`http://127.0.0.1:${address.port}/api/workflow-runs/missing/steps/0/complete`, { method: 'POST' });
    assert.equal(missing.status, 404, 'unknown completions are never falsely acknowledged');
  } finally {
    finish();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await cleanup();
  }
});

test('readiness wait is bounded and later retries can succeed', async () => {
  const finish = beginWorkflowRecovery();
  try { assert.equal(await waitForWorkflowRecovery(5), false); }
  finally { finish(); }
  assert.equal(await waitForWorkflowRecovery(5), true);
});

test('frozen definitions survive disk, mutation of public snapshots, and deletion of the source workflow', async () => {
  const { run, cleanup } = await fixture();
  try {
    const outward = snapshot(run);
    outward.definition!.steps[0].prompt = 'mutated';
    assert.equal(run.definition!.steps[0].prompt, 'original prompt');
    await writeWorkflowRunsNow(run.projectPath, [run]);
    const [loaded] = await loadPersistedWorkflowRuns(run.projectPath);
    assert.equal(loaded.definition!.steps[0].id, 'original-step');
    restoreWorkflowRun(loaded);
    await completeWorkflowStep(run.id, 0, 'http://127.0.0.1:1');
    assert.equal(runs.get(run.id)?.status, 'completed', 'no workflow with this ID exists in the editor store');
  } finally { await cleanup(); }
});

test('crash after a completion checkpoint advances without a live terminal or prompt replay', async () => {
  const { run, cleanup } = await fixture();
  try {
    run.stepPhase = 'completing';
    await writeWorkflowRunsNow(run.projectPath, [run]);
    const [loaded] = await loadPersistedWorkflowRuns(run.projectPath);
    await resumePersistedRun(loaded, [], 'http://127.0.0.1:1');
    assert.equal(runs.get(run.id)?.status, 'completed');
    assert.equal(runs.get(run.id)?.currentStepIndex, 1);
  } finally { await cleanup(); }
});

test('only never-admitted agents are replayable; ambiguous spawn and dead running agents require inspection', () => {
  const base = { status: 'running' as const, currentStepIndex: 0, definitionStepCount: 1,
    stepKind: 'agent' as const, stepSessionAlive: false };
  assert.equal(classifyWorkflowRunResume({ ...base, stepPhase: 'pending' }).action, 'redispatch');
  assert.equal(classifyWorkflowRunResume({ ...base, stepPhase: 'spawning' }).action, 'error');
  assert.equal(classifyWorkflowRunResume({ ...base, stepPhase: 'running' }).action, 'error');
  assert.equal(classifyWorkflowRunResume({ ...base, stepPhase: 'completing' }).action, 'complete');
  // A `pending` step never requested a terminal (the `spawning` checkpoint
  // precedes the pty call and a failed checkpoint prevents it), so an
  // unprobeable terminal-server changes nothing: there is no session to
  // re-adopt, and re-adopting would park the run forever — a real risk now
  // that a step's pre-run Opengrep scan keeps it `pending` for minutes.
  assert.equal(classifyWorkflowRunResume({ ...base, stepPhase: 'pending', stepSessionAlive: null }).action, 'redispatch');
  assert.equal(classifyWorkflowRunResume({ ...base, stepPhase: 'spawning', stepSessionAlive: null }).action, 'readopt');
  assert.equal(findStepSessionId([{ id: 'other', cwd: '/step' }], '/step', 'owner'), null);
});

test('terminal creation starts only after the spawning checkpoint and records the returned session ID', async () => {
  const { run, cleanup } = await fixture();
  runs.set(run.id, run);
  queueState.accounting.reconcile(0, Date.now() + 1);
  try {
    await enqueueWorkflowStepSession({ run, stepIndex: 0, projectPath: run.projectPath,
      stepDir: run.projectPath, command: 'claude', harness: 'claude', deps: {
        proxyCreateSession: async () => {
          const [saved] = await loadPersistedWorkflowRuns(run.projectPath);
          assert.equal(saved.stepPhase, 'spawning');
          return { id: 'durable-session' };
        },
      } });
    const [saved] = await loadPersistedWorkflowRuns(run.projectPath);
    assert.equal(saved.stepPhase, 'running');
    assert.equal(saved.stepSessionId, 'durable-session');
  } finally { await cleanup(); }
});

test('a failed required checkpoint prevents terminal creation', async (t) => {
  const { run, cleanup } = await fixture();
  queueState.accounting.reconcile(0, Date.now() + 1);
  let spawned = false;
  const mock = t.mock.method(fs, 'rename', async () => { throw new Error('disk write refused'); });
  try {
    await assert.rejects(enqueueWorkflowStepSession({ run, stepIndex: 0, projectPath: run.projectPath,
      stepDir: run.projectPath, command: 'claude', harness: 'claude', deps: {
        proxyCreateSession: async () => { spawned = true; return { id: 'never' }; },
      } }), /disk write refused/);
    assert.equal(spawned, false);
  } finally { mock.mock.restore(); await cleanup(); }
});

test('failed completion persistence rejects without terminal teardown and a retry succeeds', async (t) => {
  const { run, cleanup } = await fixture();
  runs.set(run.id, run);
  let killed = 0;
  const deps = { killStepSession: async () => { killed++; } };
  const mock = t.mock.method(fs, 'rename', async () => { throw new Error('completion disk failure'); });
  try {
    await assert.rejects(completeWorkflowStep(run.id, 0, 'http://127.0.0.1:1', deps), /completion disk failure/);
    assert.equal(killed, 0);
    assert.equal(run.status, 'running');
    assert.equal(run.stepPhase, 'running');
    mock.mock.restore();
    await completeWorkflowStep(run.id, 0, 'http://127.0.0.1:1', deps);
    assert.equal(run.status, 'completed');
    assert.equal(killed, 1);
  } finally { mock.mock.restore(); await cleanup(); }
});

test('a session allocated before its running checkpoint fails is reclaimed', async (t) => {
  const { run, cleanup } = await fixture();
  runs.set(run.id, run);
  queueState.accounting.reconcile(0, Date.now() + 1);
  const rename = fs.rename;
  let allocated = false;
  const killed: string[] = [];
  const mock = t.mock.method(fs, 'rename', async (...args: Parameters<typeof fs.rename>) => {
    if (allocated) throw new Error('running checkpoint failed');
    return rename(...args);
  });
  try {
    await assert.rejects(enqueueWorkflowStepSession({ run, stepIndex: 0, projectPath: run.projectPath,
      stepDir: run.projectPath, command: 'claude', harness: 'claude', deps: {
        proxyCreateSession: async () => { allocated = true; return { id: 'allocated' }; },
        proxyKillSession: async (id) => { killed.push(id); return true; },
      } }), /running checkpoint failed/);
    assert.deepEqual(killed, ['allocated']);
  } finally { mock.mock.restore(); await cleanup(); }
});

test('the next step can complete while its predecessor is still returning from dispatch', async () => {
  const { run, cleanup } = await fixture();
  run.definition!.steps.push({ ...run.definition!.steps[0], id: 'next' });
  run.totalSteps = 2;
  runs.set(run.id, run);
  try {
    await completeWorkflowStep(run.id, 0, 'http://127.0.0.1:1', {
      killStepSession: async () => {},
      dispatchStep: async () => {
        await completeWorkflowStep(run.id, 1, 'http://127.0.0.1:1', { killStepSession: async () => {} });
      },
    });
    assert.equal(run.status, 'completed');
  } finally { await cleanup(); }
});

test('first resumed run cannot checkpoint away its not-yet-dispatched siblings', async () => {
  const { run, cleanup } = await fixture();
  run.stepPhase = 'completing';
  const sibling = { ...snapshot(run), id: run.id + '_sibling', stepPhase: 'pending' as const };
  try {
    await writeWorkflowRunsNow(run.projectPath, [run, sibling]);
    const loaded = await loadPersistedWorkflowRuns(run.projectPath);
    registerPersistedWorkflowRuns(loaded, []);
    await resumePersistedRun(loaded[0], [], 'http://127.0.0.1:1', true);
    assert.deepEqual((await loadPersistedWorkflowRuns(run.projectPath)).map((r) => r.id), [sibling.id]);
  } finally { runs.delete(sibling.id); await cleanup(); }
});

test('an invalid version-2 definition remains a visible recovery error instead of disappearing', async () => {
  const { run, cleanup } = await fixture();
  try {
    const [loaded] = deserializeWorkflowRuns({ version: 2, runs: [{ ...run, definition: { id: 'wrong' } }] });
    assert.ok(loaded);
    assert.match(loaded.definitionError!, /invalid/);
    await resumePersistedRun(loaded, [], 'http://127.0.0.1:1');
    assert.match(runs.get(run.id)?.error ?? '', /persisted workflow definition is invalid/);
  } finally { await cleanup(); }
});
