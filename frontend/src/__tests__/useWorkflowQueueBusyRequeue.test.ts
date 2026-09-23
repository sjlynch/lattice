import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import type { Workflow, WorkflowQueueEntry, WorkflowRun } from '../api';
import type { QueueAction } from '../components/workflows/queueScheduler.ts';
import type { StartOutcome } from '../components/workflows/hooks/useWorkflowRunActions.ts';
import { useWorkflowQueue } from '../components/workflows/hooks/useWorkflowQueue.ts';

// Regression for the "sequential queue ran two workflows at once" bug. The
// frontend gate reads only the client's activeRuns, so it can dispatch the next
// entry during a run's startup window (run live server-side, not yet in
// activeRuns). The backend 409s any start while a run is active for the
// project; the queue must treat that 409 (`{status:'busy'}`) as a REQUEUE
// (dispatchRejected), then retry — never a drop, never a silent second
// concurrent run.

function workflow(id: string, projectPath: string): Workflow {
  return { id, name: `wf ${id}`, projectPath, steps: [], variables: [], createdAt: 0 };
}

function run(id: string, workflowId: string, projectPath: string): WorkflowRun {
  return {
    id,
    workflowId,
    workflowName: `wf ${workflowId}`,
    projectPath,
    status: 'running',
    startedAt: 0,
    totalSteps: 1,
    currentStepIndex: 0,
  };
}

function entry(id: string, workflowId: string): WorkflowQueueEntry {
  return { id, workflowId, harnessOverride: null };
}

type RunCall = { workflowId: string; entryId: string };

let latestDispatch: (action: QueueAction) => void = () => {};
let latestState: ReturnType<typeof useWorkflowQueue>['state'] | null = null;
let runCalls: RunCall[] = [];

type Props = {
  activeFolder: string;
  workflowsById: Map<string, Workflow>;
  activeRuns: Record<string, WorkflowRun>;
  runWorkflow: (wf: Workflow, e: WorkflowQueueEntry) => Promise<StartOutcome>;
};

function Harness({ activeFolder, workflowsById, activeRuns, runWorkflow }: Props) {
  const { state, dispatch } = useWorkflowQueue({
    activeFolder,
    workflowsById,
    runWorkflow,
    activeRuns,
    recentRuns: {},
  });
  latestDispatch = dispatch;
  latestState = state;
  return null;
}

const g = globalThis as unknown as Record<string, unknown>;
let savedActEnv: unknown;

beforeEach(() => {
  runCalls = [];
  latestState = null;
  savedActEnv = g.IS_REACT_ACT_ENVIRONMENT;
  g.IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  if (savedActEnv === undefined) delete g.IS_REACT_ACT_ENVIRONMENT;
  else g.IS_REACT_ACT_ENVIRONMENT = savedActEnv;
});

test('a 409 (busy) requeues the entry and retries', async () => {
  const folder = 'C:/p';
  const map = new Map<string, Workflow>([['wf1', workflow('wf1', folder)]]);

  // First dispatch: backend 409 (a run is already active server-side though not
  // in the client's activeRuns). Second: the slot freed, so it starts.
  const runWorkflow = (wf: Workflow, e: WorkflowQueueEntry): Promise<StartOutcome> => {
    runCalls.push({ workflowId: wf.id, entryId: e.id });
    if (runCalls.length === 1) return Promise.resolve({ status: 'busy' });
    return Promise.resolve({ status: 'started', run: run(`run-${e.id}`, wf.id, wf.projectPath) });
  };

  let renderer: ReturnType<typeof TestRenderer.create> | null = null;
  await act(async () => {
    renderer = TestRenderer.create(
      React.createElement(Harness, {
        activeFolder: folder,
        workflowsById: map,
        activeRuns: {},
        runWorkflow,
      }),
    );
  });

  await act(async () => {
    latestDispatch({ type: 'enqueue', entry: entry('q1', 'wf1') });
    latestDispatch({ type: 'startQueue' });
  });
  // Flush the busy resolution → dispatchRejected → retry → started.
  await act(async () => {});

  assert.equal(runCalls.length, 2, 'the entry is retried after the 409, not dropped');
  assert.deepEqual(
    runCalls.map((c) => c.entryId),
    ['q1', 'q1'],
    'the retry re-dispatches the same entry',
  );
  assert.deepEqual(
    latestState!.started.map((s) => ({ id: s.id, runId: s.runId })),
    [{ id: 'q1', runId: 'run-q1' }],
    'the retry attaches the run — exactly one run, never a dropped or duplicated entry',
  );
  assert.deepEqual(latestState!.queued, [], 'nothing left queued after a successful retry');
  assert.equal(latestState!.running, true, 'queue stays running while its run is active');

  await act(async () => {
    renderer!.unmount();
  });
});
