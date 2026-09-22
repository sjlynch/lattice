import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { canonicalProjectPath } from '../projectPath.js';
import { runControlStepWorker } from '../workflowRuns/controlStep.js';
import {
  MAX_FINISHED_RUNS_PER_PROJECT,
  notify,
  runs,
  snapshot,
  subscribe,
  type WorkflowRun,
} from '../workflowRuns/state.js';
import { cancelWorkflowRun, failWorkflowRun } from '../workflowRuns.js';
import { workflowStepAgentId } from '../workflowRuns/sessionSpawner.js';
import { agentQuiescence, noteAgentSignal } from '../agentQuiescence.js';
import { flushWorkflowRunPersist, writeWorkflowRunsNow } from '../workflowRuns/persistence.js';
import type { Workflow } from '../workflows.js';

// Terminal-state edges of a workflow run: a control-step failure must not
// clobber a run the user already cancelled, terminal transitions drop the
// step's quiescence state, and finished runs are bounded in the registry.

const PROJECT = canonicalProjectPath(
  path.join(os.tmpdir(), `lattice-wf-terminal-state-${process.pid}`),
);

function makeRun(id: string, over: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    id,
    workflowId: 'wf',
    workflowName: 'wf',
    projectPath: PROJECT,
    status: 'running',
    startedAt: Date.now(),
    totalSteps: 1,
    currentStepIndex: 0,
    ...over,
  };
}

async function settlePersistence(): Promise<void> {
  await flushWorkflowRunPersist(PROJECT);
  await writeWorkflowRunsNow(PROJECT, []);
}

test('a control-step worker error after the run was cancelled keeps `cancelled` and emits no second terminal event', async () => {
  const run = makeRun(`wfrun_cancel_then_throw_${Date.now()}`);
  const wf = { projectPath: PROJECT, steps: [{ kind: 'merge' }] } as unknown as Workflow;
  const events: string[] = [];
  const unsub = subscribe((ev) => {
    if ('run' in ev && ev.run.id === run.id) events.push(ev.type);
  });
  let completed = false;
  try {
    await runControlStepWorker(
      wf,
      run,
      0,
      'http://127.0.0.1:1',
      async () => {
        completed = true;
      },
      {
        // Cancel lands while the lock acquire is pending, then the acquire
        // throws — the shape that used to flip the run to `errored`.
        acquireLock: async () => {
          run.status = 'cancelled';
          run.finishedAt = Date.now();
          throw new Error('lock acquire aborted');
        },
        runStart: async () => undefined,
        runMerge: async () => undefined,
        runPush: async () => undefined,
      },
    );
    assert.equal(run.status, 'cancelled');
    assert.equal(run.error, undefined);
    assert.deepEqual(events, [], 'no second terminal notify');
    assert.equal(completed, false);
  } finally {
    unsub();
  }
});

test('cancel and fail forget the current step\'s quiescence state', async () => {
  const cancelled = makeRun(`wfrun_forget_cancel_${Date.now()}`);
  const failed = makeRun(`wfrun_forget_fail_${Date.now()}`, { currentStepIndex: 2 });
  runs.set(cancelled.id, cancelled);
  runs.set(failed.id, failed);
  const cancelledAgent = workflowStepAgentId(cancelled.id, 0);
  const failedAgent = workflowStepAgentId(failed.id, 2);
  try {
    noteAgentSignal(cancelledAgent);
    noteAgentSignal(failedAgent);
    assert.ok(agentQuiescence(cancelledAgent).quietForMs < 5000);
    assert.ok(agentQuiescence(failedAgent).quietForMs < 5000);

    assert.equal(cancelWorkflowRun(cancelled.id), true);
    assert.equal(agentQuiescence(cancelledAgent).quietForMs, Number.POSITIVE_INFINITY);

    assert.equal(failWorkflowRun(failed.id, 'boom'), true);
    assert.equal(agentQuiescence(failedAgent).quietForMs, Number.POSITIVE_INFINITY);
  } finally {
    runs.delete(cancelled.id);
    runs.delete(failed.id);
    await settlePersistence();
  }
});

test('finished runs are pruned to MAX_FINISHED_RUNS_PER_PROJECT per project; running runs survive', async () => {
  const prefix = `wfrun_prune_${Date.now()}`;
  const live = makeRun(`${prefix}_live`);
  runs.set(live.id, live);
  const ids: string[] = [];
  try {
    for (let i = 0; i < MAX_FINISHED_RUNS_PER_PROJECT + 5; i++) {
      const done = makeRun(`${prefix}_${i}`, { status: 'completed', finishedAt: 1_000 + i });
      runs.set(done.id, done);
      ids.push(done.id);
      notify({ type: 'completed', run: snapshot(done) });
    }
    assert.ok(runs.has(live.id), 'the running run is never pruned');
    assert.ok(!runs.has(ids[0]), 'the oldest finished run is gone');
    assert.ok(runs.has(ids[ids.length - 1]), 'the newest finished run is kept');
    const finishedHere = [...runs.values()].filter(
      (r) => r.projectPath === PROJECT && r.status !== 'running',
    ).length;
    assert.equal(finishedHere, MAX_FINISHED_RUNS_PER_PROJECT);
  } finally {
    runs.delete(live.id);
    for (const id of ids) runs.delete(id);
    await settlePersistence();
  }
});
