import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import type {
  Workflow,
  WorkflowQueueEntry,
  WorkflowRun,
} from '../api';
import type { QueueAction } from '../components/workflows/queueScheduler.ts';
import { useWorkflowQueue } from '../components/workflows/hooks/useWorkflowQueue.ts';
import { useWorkflowQueueSelectors } from '../components/workflows/hooks/useWorkflowQueueSelectors.ts';

// Regression: the workflow queue must be scoped to its project. Before the fix
// `useWorkflowQueue` held queued/started/running state in plain component state
// that was never keyed by (or reset on) activeFolder, and WorkflowsLauncher is
// not remounted on a project switch. So queueing + starting in project A, then
// switching to B, left B rendering A's running/queued status — and the moment
// B's `hello` replaced activeRuns, the activeRuns-diff fired runFinished for
// A's now-vanished run, retired A's started entry, and (queue still "running")
// drove the scheduler to start A's remaining queued entry, which wasn't in B's
// workflowsById and got silently dispatchFailed-dropped.
//
// This drives the *real* hook + its selectors headlessly. The hook only touches
// React (no WS/fetch/DOM), so we just need the act environment; folder/run
// changes are fed by re-rendering the harness with new props.

function workflow(id: string, projectPath: string): Workflow {
  return {
    id,
    name: `wf ${id}`,
    projectPath,
    steps: [],
    variables: [],
    createdAt: 0,
  };
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

// Captured from the most recent render so the test can dispatch into the live
// hook and assert on its derived selectors.
let latestDispatch: (action: QueueAction) => void = () => {};
let latestState: ReturnType<typeof useWorkflowQueue>['state'] | null = null;
let latestSelectors: ReturnType<typeof useWorkflowQueueSelectors> | null = null;

// runWorkflow calls the hook fired, recorded so the test can prove B's switch
// didn't trigger a fresh dispatch of A's leftover queued entry.
let runWorkflowCalls: Array<{ workflowId: string; entryId: string }> = [];

type Props = {
  activeFolder: string;
  workflowsById: Map<string, Workflow>;
  activeRuns: Record<string, WorkflowRun>;
};

function Harness({ activeFolder, workflowsById, activeRuns }: Props) {
  const runWorkflow = React.useCallback(
    (wf: Workflow, e: WorkflowQueueEntry) => {
      runWorkflowCalls.push({ workflowId: wf.id, entryId: e.id });
      return Promise.resolve({
        status: 'started' as const,
        run: run(`run-${e.id}`, wf.id, wf.projectPath),
      });
    },
    [],
  );
  const { state, dispatch } = useWorkflowQueue({
    activeFolder,
    workflowsById,
    runWorkflow,
    activeRuns,
    recentRuns: {},
  });
  const selectors = useWorkflowQueueSelectors({
    queueState: state,
    workflowsById,
    activeRuns,
  });
  latestDispatch = dispatch;
  latestState = state;
  latestSelectors = selectors;
  return null;
}

const g = globalThis as unknown as Record<string, unknown>;
let savedActEnv: unknown;

beforeEach(() => {
  runWorkflowCalls = [];
  latestState = null;
  latestSelectors = null;
  savedActEnv = g.IS_REACT_ACT_ENVIRONMENT;
  g.IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  if (savedActEnv === undefined) delete g.IS_REACT_ACT_ENVIRONMENT;
  else g.IS_REACT_ACT_ENVIRONMENT = savedActEnv;
});

test('queue state does not leak across a project switch', async () => {
  const folderA = 'C:/project-A';
  const folderB = 'C:/project-B';
  const mapA = new Map<string, Workflow>([
    ['wfA1', workflow('wfA1', folderA)],
    ['wfA2', workflow('wfA2', folderA)],
  ]);
  const mapB = new Map<string, Workflow>([['wfB1', workflow('wfB1', folderB)]]);

  const tree = (props: Props) => React.createElement(Harness, props);

  let renderer: ReturnType<typeof TestRenderer.create> | null = null;

  // Mount on project A with no active runs.
  await act(async () => {
    renderer = TestRenderer.create(
      tree({ activeFolder: folderA, workflowsById: mapA, activeRuns: {} }),
    );
  });

  // Queue two workflows, then Start queue (sequential). The scheduler dispatches
  // the first entry; runWorkflow resolves with run `run-eA1`, which the hook
  // attaches via workflowStarted.
  await act(async () => {
    latestDispatch({ type: 'enqueue', entry: entry('eA1', 'wfA1') });
    latestDispatch({ type: 'enqueue', entry: entry('eA2', 'wfA2') });
  });
  await act(async () => {
    latestDispatch({ type: 'startQueue' });
  });

  // The first run is now active server-side; surface it in activeRuns. The diff
  // adds a run (no removals) so nothing finishes.
  await act(async () => {
    renderer!.update(
      tree({
        activeFolder: folderA,
        workflowsById: mapA,
        activeRuns: { 'run-eA1': run('run-eA1', 'wfA1', folderA) },
      }),
    );
  });

  // Sanity: A's queue is mid-flight — one entry running, one still queued.
  assert.equal(latestState!.running, true, 'project A queue should be running');
  assert.deepEqual(
    latestState!.queued.map((e) => e.id),
    ['eA2'],
    'project A should still have one queued entry',
  );
  assert.deepEqual(
    latestState!.started.map((e) => e.id),
    ['eA1'],
    'project A should have one started entry',
  );
  const runCallsBeforeSwitch = runWorkflowCalls.length;

  // Switch to project B *before* B's `hello` arrives (activeRuns still holds
  // A's run, exactly as it would the instant the folder prop flips).
  await act(async () => {
    renderer!.update(
      tree({
        activeFolder: folderB,
        workflowsById: mapB,
        activeRuns: { 'run-eA1': run('run-eA1', 'wfA1', folderA) },
      }),
    );
  });

  // Primary regression: B sees a pristine queue — no running/queued/started
  // carried over from A, and the derived selectors are all default.
  assert.deepEqual(
    {
      mode: latestState!.mode,
      running: latestState!.running,
      queued: latestState!.queued,
      started: latestState!.started,
      preFinishedRunIds: latestState!.preFinishedRunIds,
    },
    {
      mode: 'sequential',
      running: false,
      queued: [],
      started: [],
      preFinishedRunIds: [],
    },
    "switching projects must reset the queue to its pristine per-project state",
  );
  assert.deepEqual(latestSelectors!.queuedItems, [], 'B shows no queued items');
  assert.equal(latestSelectors!.busy, false, 'B queue is not busy');
  assert.equal(
    latestSelectors!.status,
    'Queue saved workflows, then choose sequential or parallel start.',
    'B shows the empty-queue status',
  );

  // Now B's `hello` replaces activeRuns wholesale. In the buggy version this is
  // where the diff fired runFinished for A's run and the scheduler dispatch-
  // dropped A's leftover `eA2`. With the per-project reset the diff is a no-op.
  await act(async () => {
    renderer!.update(
      tree({
        activeFolder: folderB,
        workflowsById: mapB,
        activeRuns: { 'run-B1': run('run-B1', 'wfB1', folderB) },
      }),
    );
  });

  assert.equal(
    runWorkflowCalls.length,
    runCallsBeforeSwitch,
    "A's leftover queued entry must not be dispatched (or dispatchFail-dropped) after switching to B",
  );
  assert.equal(latestState!.running, false, 'B queue stays stopped');
  assert.deepEqual(latestState!.queued, [], 'B queue stays empty');
  assert.deepEqual(latestState!.started, [], 'B has no started entries');

  await act(async () => {
    renderer!.unmount();
  });
});
