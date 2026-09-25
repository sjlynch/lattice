import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import type { Workflow, WorkflowRun } from '../api';
import type {
  EditorRunResult,
  StartOutcome,
} from '../components/workflows/hooks/useWorkflowRunActions.ts';
import { useWorkflowManualRun } from '../components/workflows/hooks/useWorkflowManualRun.ts';

// A project runs one workflow at a time (the backend 409s a second start), so
// the manual ▶ Run buttons fall back to the sequential queue: when a run is
// already active — known locally, or learned from the 409 — the workflow is
// enqueued, the queue started, and a "Queued behind <name>" toast shown.

function workflow(id: string): Workflow {
  return { id, name: `wf ${id}`, projectPath: 'C:/p', steps: [], variables: [], createdAt: 0 };
}

function run(id: string, workflowName: string, startedAt = 0): WorkflowRun {
  return {
    id,
    workflowId: `id-${id}`,
    workflowName,
    projectPath: 'C:/p',
    status: 'running',
    startedAt,
    totalSteps: 1,
    currentStepIndex: 0,
  };
}

type Calls = {
  run: string[];
  runEditor: number;
  enqueue: string[];
  enqueueDefinition: string[];
  enqueueEditor: number;
  startQueue: number;
  notices: string[];
};

let calls: Calls;
let latest: ReturnType<typeof useWorkflowManualRun> | null = null;

type Props = {
  activeRuns: Record<string, WorkflowRun>;
  outcome: StartOutcome;
  editorResult?: EditorRunResult;
  editorWorkflowId?: string | null;
  // Overrides the fixed `outcome` / `editorResult` (e.g. a deferred start).
  startRun?: (id: string) => Promise<StartOutcome>;
  startEditor?: () => Promise<EditorRunResult>;
};

function Harness({
  activeRuns,
  outcome,
  editorResult = null,
  editorWorkflowId = null,
  startRun,
  startEditor,
}: Props) {
  latest = useWorkflowManualRun({
    activeRuns,
    editorWorkflowId,
    runWorkflow: async (id) => {
      calls.run.push(id);
      return startRun ? startRun(id) : outcome;
    },
    runEditorWorkflow: async () => {
      calls.runEditor += 1;
      return startEditor ? startEditor() : editorResult;
    },
    enqueueWorkflow: (id) => {
      calls.enqueue.push(id);
      return true;
    },
    enqueueWorkflowDefinition: (wf) => {
      calls.enqueueDefinition.push(wf.id);
      return true;
    },
    enqueueEditorWorkflow: async () => {
      calls.enqueueEditor += 1;
      return true;
    },
    startQueuedWorkflows: () => {
      calls.startQueue += 1;
    },
    notify: (msg) => {
      calls.notices.push(msg);
    },
  });
  return null;
}

const g = globalThis as unknown as Record<string, unknown>;
let savedActEnv: unknown;

beforeEach(() => {
  calls = {
    run: [],
    runEditor: 0,
    enqueue: [],
    enqueueDefinition: [],
    enqueueEditor: 0,
    startQueue: 0,
    notices: [],
  };
  latest = null;
  savedActEnv = g.IS_REACT_ACT_ENVIRONMENT;
  g.IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  if (savedActEnv === undefined) delete g.IS_REACT_ACT_ENVIRONMENT;
  else g.IS_REACT_ACT_ENVIRONMENT = savedActEnv;
});

async function render(props: Props) {
  let renderer: ReturnType<typeof TestRenderer.create> | null = null;
  await act(async () => {
    renderer = TestRenderer.create(React.createElement(Harness, props));
  });
  return async () => {
    await act(async () => {
      renderer!.unmount();
    });
  };
}

test('with no active run, ▶ Run starts the workflow and queues nothing', async () => {
  const unmount = await render({
    activeRuns: {},
    outcome: { status: 'started', run: run('r1', 'wf wf1') },
  });
  await act(async () => {
    await latest!.runWorkflowOrQueue('wf1');
  });
  assert.deepEqual(calls.run, ['wf1']);
  assert.deepEqual(calls.enqueue, []);
  assert.equal(calls.startQueue, 0);
  assert.deepEqual(calls.notices, []);
  await unmount();
});

test('with a run already active, ▶ Run queues behind it without a start request', async () => {
  const unmount = await render({
    activeRuns: { later: run('later', 'Docs', 5), first: run('first', 'Refactor', 1) },
    outcome: { status: 'failed' },
  });
  await act(async () => {
    await latest!.runWorkflowOrQueue('wf2');
  });
  assert.deepEqual(calls.run, [], 'no /run request while a run is known to be active');
  assert.deepEqual(calls.enqueue, ['wf2']);
  assert.equal(calls.startQueue, 1, 'the queue is started so the entry never sits idle');
  assert.deepEqual(calls.notices, ['Queued behind "Refactor"'], 'names the oldest active run');
  await unmount();
});

test('a 409 the tab did not see coming still queues the workflow', async () => {
  const unmount = await render({ activeRuns: {}, outcome: { status: 'busy' } });
  await act(async () => {
    await latest!.runWorkflowOrQueue('wf3');
  });
  assert.deepEqual(calls.run, ['wf3']);
  assert.deepEqual(calls.enqueue, ['wf3']);
  assert.equal(calls.startQueue, 1);
  assert.deepEqual(calls.notices, ['Queued behind the active workflow']);
  await unmount();
});

test('the editor ▶ Run queues the saved editor workflow when a run is active', async () => {
  const unmount = await render({
    activeRuns: { a: run('a', 'Refactor') },
    outcome: { status: 'failed' },
  });
  await act(async () => {
    await latest!.runEditorWorkflowOrQueue();
  });
  assert.equal(calls.runEditor, 0);
  assert.equal(calls.enqueueEditor, 1, 'saves + enqueues the editor workflow');
  assert.deepEqual(calls.notices, ['Queued behind "Refactor"']);
  await unmount();
});

test('the editor ▶ Run queues the workflow it just saved when the start 409s', async () => {
  const unmount = await render({
    activeRuns: {},
    outcome: { status: 'failed' },
    editorResult: { workflow: workflow('fresh'), outcome: { status: 'busy' } },
  });
  await act(async () => {
    await latest!.runEditorWorkflowOrQueue();
  });
  assert.equal(calls.runEditor, 1);
  assert.deepEqual(calls.enqueueDefinition, ['fresh'], 'enqueued by definition, not by id lookup');
  assert.equal(calls.startQueue, 1);
  assert.equal(calls.notices.length, 1);
  await unmount();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

test('REGRESSION: a double-clicked ▶ Run starts once and never queues its own 409', async () => {
  // The first start is still in flight (activeRuns hasn't learned of it yet);
  // any further start would 409 against it and come back `busy`.
  const first = deferred<StartOutcome>();
  let starts = 0;
  const unmount = await render({
    activeRuns: {},
    outcome: { status: 'failed' },
    startRun: () => (++starts === 1 ? first.promise : Promise.resolve<StartOutcome>({ status: 'busy' })),
  });
  let p1!: Promise<void>;
  let p2!: Promise<void>;
  await act(async () => {
    p1 = latest!.runWorkflowOrQueue('wf');
    p2 = latest!.runWorkflowOrQueue('wf');
    await p2;
  });
  assert.equal(latest!.startingWorkflowIds.has('wf'), true, 'the row ▶ is disabled while pending');
  await act(async () => {
    first.resolve({ status: 'started', run: run('r1', 'wf wf') });
    await p1;
  });
  assert.deepEqual(calls.run, ['wf'], 'one start request');
  assert.deepEqual(calls.enqueue, [], 'the second click never queues a second run');
  assert.equal(calls.startQueue, 0);
  assert.deepEqual(calls.notices, []);
  assert.equal(latest!.startingWorkflowIds.has('wf'), false, 'released once the start settles');
  // Once settled, a later click is honoured again.
  await act(async () => {
    await latest!.runWorkflowOrQueue('wf');
  });
  assert.deepEqual(calls.run, ['wf', 'wf']);
  await unmount();
});

test("a pending editor ▶ Run holds the saved-list ▶ of the editor's workflow too", async () => {
  const first = deferred<EditorRunResult>();
  const unmount = await render({
    activeRuns: {},
    outcome: { status: 'busy' },
    editorWorkflowId: 'wf',
    startEditor: () => first.promise,
  });
  let pEditor!: Promise<void>;
  await act(async () => {
    pEditor = latest!.runEditorWorkflowOrQueue();
    await latest!.runEditorWorkflowOrQueue();
    await latest!.runWorkflowOrQueue('wf');
  });
  assert.equal(latest!.editorStarting, true);
  assert.equal(calls.runEditor, 1);
  assert.deepEqual(calls.run, [], 'the list ▶ of the same workflow is dropped');
  await act(async () => {
    first.resolve({ workflow: workflow('wf'), outcome: { status: 'started', run: run('r', 'wf wf') } });
    await pEditor;
  });
  assert.equal(latest!.editorStarting, false);
  assert.deepEqual(calls.enqueue, []);
  assert.deepEqual(calls.enqueueDefinition, []);
  await unmount();
});
