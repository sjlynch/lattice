import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import type { WorkflowRun, WorkflowRunEvent } from '../api';
import { TerminalsProvider } from '../TerminalsContext.tsx';
import { useWorkflowRuns } from '../components/workflows/hooks/useWorkflowRuns.ts';

// Regression: recent workflow runs must be scoped to their project. Before the
// fix, a finished/failed run from project A lingered in `recentRuns` forever
// after switching the active project to B — the effect's `!activeFolder` reset
// branch never fired (B is truthy) and nothing else cleared recentRuns, while
// the A-effect's cleanup cancelled A's pending auto-dismiss timer. So A's
// stale runs surfaced in project B's UI with no timer to ever remove them.
//
// This drives the *real* hook headlessly. useWorkflowRuns reaches for browser
// globals at call time — it opens a `/ws/workflow-runs` WebSocket, fetches
// `/api/workflow-runs/active`, and listens for `visibilitychange` — so we stub
// each one. The FakeWebSocket exposes `emit` to push a server event into the
// hook's live subscription by hand; react-test-renderer drives the effect
// lifecycle across the folder change (mount A -> errored event -> switch to B).

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
  }
  close() {}
  /** Push a server event into this socket's live subscription. */
  emit(ev: WorkflowRunEvent) {
    this.onmessage?.({ data: JSON.stringify(ev) });
  }
}

/** The socket opened by the most recent subscription. */
function latestSocket(): FakeWebSocket {
  const ws = FakeWebSocket.instances.at(-1);
  assert.ok(ws, 'expected the hook to have opened a WebSocket');
  return ws;
}

// The hook's most recently rendered `recentRuns`, captured each render.
let latestRecentRuns: Record<string, WorkflowRun> = {};
function Harness({ folder }: { folder: string }) {
  const { recentRuns } = useWorkflowRuns(folder);
  latestRecentRuns = recentRuns;
  return null;
}

function erroredRun(id: string, projectPath: string): WorkflowRun {
  return {
    id,
    workflowId: `wf-${id}`,
    workflowName: `flow ${id}`,
    projectPath,
    status: 'errored',
    startedAt: 0,
    totalSteps: 2,
    currentStepIndex: 1,
    error: 'boom',
  };
}

function fakeStorage() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string) => void m.set(k, String(v)),
    removeItem: (k: string) => void m.delete(k),
  };
}

let saved: Record<string, unknown>;
const g = globalThis as unknown as Record<string, unknown>;

beforeEach(() => {
  FakeWebSocket.instances = [];
  latestRecentRuns = {};
  saved = {
    IS_REACT_ACT_ENVIRONMENT: g.IS_REACT_ACT_ENVIRONMENT,
    React: g.React,
    WebSocket: g.WebSocket,
    window: g.window,
    document: g.document,
    fetch: g.fetch,
    sessionStorage: g.sessionStorage,
    localStorage: g.localStorage,
  };
  g.IS_REACT_ACT_ENVIRONMENT = true;
  // `tsx` resolves the root tsconfig.json (no `jsx` option) and so compiles the
  // app's .tsx files with the *classic* JSX runtime — they emit
  // `React.createElement` without importing React. Expose it globally so those
  // components (TerminalsProvider, …) render under the test runner.
  g.React = React;
  g.WebSocket = FakeWebSocket;
  g.window = {
    location: { protocol: 'http:', host: 'localhost:5184' },
    addEventListener() {},
    removeEventListener() {},
  };
  g.document = {
    visibilityState: 'visible',
    addEventListener() {},
    removeEventListener() {},
  };
  // The active-runs fetch resolves empty; recentRuns (not activeRuns) is what
  // this test exercises.
  g.fetch = () => Promise.resolve({ ok: true, json: async () => [] });
  g.sessionStorage = fakeStorage();
  g.localStorage = fakeStorage();
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete g[k];
    else g[k] = v;
  }
});

test('recent runs from the previous project are cleared on folder change', () => {
  let renderer: ReturnType<typeof TestRenderer.create> | null = null;
  const tree = (folder: string) =>
    React.createElement(
      TerminalsProvider,
      null,
      React.createElement(Harness, { folder }),
    );

  // Mount on project A.
  act(() => {
    renderer = TestRenderer.create(tree('C:/project-A'));
  });

  // A workflow run errors in project A: it lands in recentRuns with a 5-min
  // linger timer. Drive the `errored` event through the live WS subscription.
  act(() => {
    latestSocket().emit({
      type: 'errored',
      run: erroredRun('run-A1', 'C:/project-A'),
    });
  });
  assert.deepEqual(
    Object.keys(latestRecentRuns),
    ['run-A1'],
    'the errored run should linger in recentRuns while project A is active',
  );

  // Switch the active project to B before the linger timer fires.
  act(() => {
    renderer!.update(tree('C:/project-B'));
  });

  // Project A's recent runs must not leak into project B.
  assert.deepEqual(
    latestRecentRuns,
    {},
    "switching projects must clear the previous project's recent runs",
  );

  act(() => {
    renderer!.unmount();
  });
});
