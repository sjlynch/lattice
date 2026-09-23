import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
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
import {
  cancelWorkflowRun,
  completeWorkflowStep,
  failWorkflowRun,
  startWorkflowRun,
} from '../workflowRuns.js';
import { createWorkflow } from '../workflows.js';
import { workflowStepAgentId } from '../workflowRuns/sessionSpawner.js';
import { agentQuiescence, noteAgentSignal } from '../agentQuiescence.js';
import {
  flushWorkflowRunPersist,
  loadPersistedWorkflowRuns,
  workflowRunsFile,
  writeWorkflowRunsNow,
} from '../workflowRuns/persistence.js';
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

test('a completeStep rejection after the run was cancelled keeps `cancelled`', async () => {
  const run = makeRun(`wfrun_cancel_then_advance_fail_${Date.now()}`);
  const wf = { projectPath: PROJECT, steps: [{ kind: 'merge' }] } as unknown as Workflow;
  const events: string[] = [];
  const unsub = subscribe((ev) => {
    if ('run' in ev && ev.run.id === run.id) events.push(ev.type);
  });
  try {
    await runControlStepWorker(
      wf,
      run,
      0,
      'http://127.0.0.1:1',
      async () => {
        // Cancel lands during the advance, whose checkpoint then fails.
        run.status = 'cancelled';
        run.finishedAt = Date.now();
        throw new Error('completion checkpoint failed');
      },
      {
        acquireLock: async () => ({ release: async () => undefined }) as never,
        runStart: async () => undefined,
        runMerge: async () => undefined,
        runPush: async () => undefined,
      },
    );
    assert.equal(run.status, 'cancelled');
    assert.equal(run.error, undefined);
    assert.deepEqual(events, [], 'no errored event over the cancel');
  } finally {
    unsub();
  }
});

test('a failed advance dispatch errors the run durably and forgets the next step\'s quiescence', async () => {
  const run = makeRun(`wfrun_advance_dispatch_fail_${Date.now()}`, {
    totalSteps: 2,
    stepPhase: 'running',
    definition: {
      id: 'wf', name: 'wf', projectPath: PROJECT, createdAt: 1, variables: [], steps: [
        { id: 'a', title: 'A', prompt: 'a', mode: 'sequential', harness: 'claude' },
        { id: 'b', title: 'B', prompt: 'b', mode: 'sequential', harness: 'claude' },
      ],
    },
  });
  runs.set(run.id, run);
  const nextAgent = workflowStepAgentId(run.id, 1);
  try {
    await completeWorkflowStep(run.id, 0, 'http://127.0.0.1:1', {
      killStepSession: async () => {},
      dispatchStep: async () => {
        noteAgentSignal(nextAgent);
        throw new Error('dispatch exploded');
      },
    });
    assert.equal(run.status, 'errored');
    assert.match(run.error ?? '', /dispatch exploded/);
    assert.equal(agentQuiescence(nextAgent).quietForMs, Number.POSITIVE_INFINITY);
    // The terminal checkpoint is issued immediately: the run leaves disk well
    // inside the 100 ms debounce (no flush, which would mask a missing one).
    const deadline = Date.now() + 60;
    let onDisk = true;
    while (Date.now() < deadline) {
      onDisk = (await loadPersistedWorkflowRuns(PROJECT)).some((r) => r.id === run.id);
      if (!onDisk) break;
      await new Promise((r) => setTimeout(r, 5));
    }
    assert.equal(onDisk, false, 'errored run still mirrored as running');
  } finally {
    runs.delete(run.id);
    await settlePersistence();
  }
});

test('a start whose setup fails after a cancel keeps `cancelled`', async (t) => {
  const project = await fs.mkdtemp(path.join(os.tmpdir(), 'lattice-wf-start-cancel-'));
  const wf = await createWorkflow(project, 'start-cancel', [
    { id: 's1', title: 'Step 1', prompt: 'do it', mode: 'sequential', harness: 'claude' },
  ]);
  const file = workflowRunsFile(wf.projectPath);
  let runId = '';
  const unsub = subscribe((ev) => {
    if (ev.type === 'started' && ev.run.projectPath === wf.projectPath) runId = ev.run.id;
  });
  const rename = fs.rename;
  t.mock.method(fs, 'rename', async (...args: Parameters<typeof fs.rename>) => {
    if (runId && String(args[1]) === file && runs.get(runId)?.status === 'running') {
      cancelWorkflowRun(runId);
      throw new Error('checkpoint refused');
    }
    return rename(...args);
  });
  try {
    await assert.rejects(startWorkflowRun(wf.id, 'http://127.0.0.1:1'), /checkpoint refused/);
    assert.ok(runId);
    assert.equal(runs.get(runId)?.status, 'cancelled');
    assert.equal(runs.get(runId)?.error, undefined);
  } finally {
    t.mock.restoreAll();
    unsub();
    if (runId) runs.delete(runId);
    await flushWorkflowRunPersist(wf.projectPath);
    await writeWorkflowRunsNow(wf.projectPath, []);
    await fs.rm(project, { recursive: true, force: true });
  }
});

// UserSettings.keepWorkflowStepTerminals: a finished agent step's pty is left
// running (its `wf:stepN` tab stays readable) instead of killed on advance;
// the run advances exactly as before. Default: killed.
test('keepWorkflowStepTerminals leaves the finished step session running; default kills it', async () => {
  const { patchUserSettings } = await import('../userSettings.js');
  const project = canonicalProjectPath(await fs.mkdtemp(path.join(os.tmpdir(), 'lattice-wf-keep-open-')));
  const steps = [
    { id: 'a', title: 'A', prompt: 'a', mode: 'sequential' as const, harness: 'claude' as const },
    { id: 'b', title: 'B', prompt: 'b', mode: 'sequential' as const, harness: 'claude' as const },
  ];
  const advanceOnce = async (label: string) => {
    const run = makeRun(`wfrun_keep_open_${label}_${Date.now()}`, {
      projectPath: project,
      totalSteps: 2,
      stepPhase: 'running',
      definition: { id: 'wf', name: 'wf', projectPath: project, createdAt: 1, variables: [], steps },
    });
    runs.set(run.id, run);
    const calls: string[] = [];
    try {
      await completeWorkflowStep(run.id, 0, 'http://127.0.0.1:1', {
        killStepSession: async () => { calls.push('kill'); },
        releaseStepSession: async () => { calls.push('release'); },
        dispatchStep: async () => {},
      });
      assert.equal(run.currentStepIndex, 1, 'the run advances either way');
      return calls;
    } finally {
      runs.delete(run.id);
    }
  };
  try {
    assert.deepEqual(await advanceOnce('default'), ['kill']);
    await patchUserSettings(project, { keepWorkflowStepTerminals: true });
    assert.deepEqual(await advanceOnce('keep'), ['release']);
  } finally {
    await settlePersistence();
    await fs.rm(project, { recursive: true, force: true });
  }
});
