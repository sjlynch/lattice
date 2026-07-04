import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import type { Workflow, WorkflowRun } from '../api';
import { FakeWebSocket } from './domDoubles.ts';
import { emptyEditor } from '../components/workflows/editorState.ts';
import { useWorkflowList } from '../components/workflows/hooks/useWorkflowList.ts';
import {
  useWorkflowRunActions,
  type StartOutcome,
} from '../components/workflows/hooks/useWorkflowRunActions.ts';

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (err: unknown) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function workflow(id: string, projectPath: string): Workflow {
  return {
    id,
    name: `workflow ${id}`,
    projectPath,
    steps: [],
    variables: [],
    createdAt: id.endsWith('B') ? 2 : 1,
  };
}

function run(id: string, workflowId: string, projectPath: string): WorkflowRun {
  return {
    id,
    workflowId,
    workflowName: `workflow ${workflowId}`,
    projectPath,
    status: 'running',
    startedAt: 0,
    totalSteps: 1,
    currentStepIndex: 0,
  };
}

function responseJson(value: unknown) {
  return { ok: true, status: 200, json: () => Promise.resolve(value) };
}

async function flush() {
  for (let i = 0; i < 6; i++) await Promise.resolve();
}

const g = globalThis as unknown as Record<string, unknown>;
let saved: Record<string, unknown>;

beforeEach(() => {
  FakeWebSocket.instances = [];
  saved = {
    IS_REACT_ACT_ENVIRONMENT: g.IS_REACT_ACT_ENVIRONMENT,
    React: g.React,
    WebSocket: g.WebSocket,
    window: g.window,
    fetch: g.fetch,
  };
  g.IS_REACT_ACT_ENVIRONMENT = true;
  g.React = React;
  g.WebSocket = FakeWebSocket;
  g.window = {
    location: { protocol: 'http:', host: 'localhost:5184' },
    addEventListener() {},
    removeEventListener() {},
  };
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete g[k];
    else g[k] = v;
  }
});

let latestWorkflows: Workflow[] = [];
function WorkflowListHarness({ folder }: { folder: string }) {
  const { workflows } = useWorkflowList(folder);
  latestWorkflows = workflows;
  return null;
}

test("workflow list clears the previous project's saved workflows while the new project fetch is pending", async () => {
  const folderA = 'C:/project-A';
  const folderB = 'C:/project-B';
  const wfA = workflow('wfA', folderA);
  const wfB = workflow('wfB', folderB);
  const fetchB = deferred<unknown>();

  g.fetch = (url: string) => {
    const raw = String(url);
    if (raw.includes('/api/workflows?')) {
      const project = decodeURIComponent(raw.split('project=')[1] ?? '');
      if (project === folderA) return Promise.resolve(responseJson([wfA]));
      if (project === folderB) return fetchB.promise;
    }
    return Promise.resolve(responseJson([]));
  };

  let renderer!: ReturnType<typeof TestRenderer.create>;
  const tree = (folder: string) => React.createElement(WorkflowListHarness, { folder });

  await act(async () => {
    renderer = TestRenderer.create(tree(folderA));
  });
  await act(async () => {
    await flush();
  });
  assert.deepEqual(
    latestWorkflows.map((w) => w.id),
    ['wfA'],
    "project A's workflows should be loaded before the switch",
  );

  await act(async () => {
    renderer.update(tree(folderB));
  });

  assert.deepEqual(
    latestWorkflows,
    [],
    "project A's saved workflows must be hidden while project B is still loading",
  );

  await act(async () => {
    fetchB.resolve(responseJson([wfB]));
    await flush();
  });
  assert.deepEqual(
    latestWorkflows.map((w) => w.id),
    ['wfB'],
    "project B's workflows should appear once its own fetch resolves",
  );

  act(() => renderer.unmount());
});

let latestRunWorkflow: (workflowId: string) => Promise<StartOutcome> = async () => ({
  status: 'failed',
});
let addedRuns: WorkflowRun[] = [];

function RunActionsHarness({
  folder,
  workflowsById,
}: {
  folder: string;
  workflowsById: Map<string, Workflow>;
}) {
  const actions = useWorkflowRunActions({
    activeFolder: folder,
    editor: emptyEditor(),
    workflowsById,
    save: async () => null,
    addActiveRun: (r) => { addedRuns.push(r); },
    getWorkflowHarnessOverride: () => null,
    getWorkflowPiModelOverride: () => undefined,
    onError: (msg) => { throw new Error(msg); },
  });
  latestRunWorkflow = actions.runWorkflow;
  return null;
}

test("a delayed run response from the previous project is not inserted into the current project's active runs", async () => {
  const folderA = 'C:/project-A';
  const folderB = 'C:/project-B';
  const wfA = workflow('wfA', folderA);
  const wfB = workflow('wfB', folderB);
  const mapA = new Map([[wfA.id, wfA]]);
  const mapB = new Map([[wfB.id, wfB]]);
  const runAResponse = deferred<unknown>();

  addedRuns = [];
  g.fetch = (url: string) => {
    const raw = String(url);
    if (raw.includes('/api/workflows/wfA/run')) return runAResponse.promise;
    if (raw.includes('/api/workflows/wfB/run')) {
      return Promise.resolve(responseJson({ run: run('run-B', 'wfB', folderB) }));
    }
    return Promise.resolve(responseJson({}));
  };

  let renderer!: ReturnType<typeof TestRenderer.create>;
  const tree = (folder: string, workflowsById: Map<string, Workflow>) =>
    React.createElement(RunActionsHarness, { folder, workflowsById });

  await act(async () => {
    renderer = TestRenderer.create(tree(folderA, mapA));
  });

  let pendingRun!: Promise<StartOutcome>;
  await act(async () => {
    pendingRun = latestRunWorkflow('wfA');
  });

  await act(async () => {
    renderer.update(tree(folderB, mapB));
  });

  let resolvedRun: StartOutcome | null = null;
  await act(async () => {
    runAResponse.resolve(responseJson({ run: run('run-A', 'wfA', folderA) }));
    resolvedRun = await pendingRun;
    await flush();
  });

  // Stale cross-project result → dropped as 'failed' (was `null` before the
  // StartOutcome contract; the queue treats 'failed' the same way).
  assert.deepEqual(resolvedRun, { status: 'failed' }, 'the stale project-A run result is ignored');
  assert.deepEqual(
    addedRuns,
    [],
    "project A's late run must not be added to project B's active run UI",
  );

  await act(async () => {
    const bRun = await latestRunWorkflow('wfB');
    assert.equal(bRun.status === 'started' ? bRun.run.id : null, 'run-B');
  });
  assert.deepEqual(
    addedRuns.map((r) => r.id),
    ['run-B'],
    'the currently active project can still add its own run',
  );

  act(() => renderer.unmount());
});
