import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { useQaRuns } from '../components/taskboard/hooks/useQaRuns.ts';
import type { Task } from '../api';

// Regression for useQaRuns.startQaRun: the QA card's ▶ only guarded the
// in-flight request, so clicking it again once the first session had started
// launched a SECOND Claude + Playwright session for the same task — both drove
// the same dev server and either one's confident PASS promoted the task. A task
// with a run in progress now focuses that run's terminal instead of starting
// another; a run whose tab was closed (its pty killed) no longer blocks one.

const g = globalThis as unknown as Record<string, unknown>;
let saved: Record<string, unknown>;
let qaPosts: number;

function okJson(body: unknown) {
  return { ok: true, status: 200, json: () => Promise.resolve(body) };
}

beforeEach(() => {
  qaPosts = 0;
  saved = {
    IS_REACT_ACT_ENVIRONMENT: g.IS_REACT_ACT_ENVIRONMENT,
    React: g.React,
    window: g.window,
    document: g.document,
    fetch: g.fetch,
  };
  g.IS_REACT_ACT_ENVIRONMENT = true;
  g.React = React;
  g.window = {
    addEventListener() {},
    removeEventListener() {},
    setInterval: () => 0,
    clearInterval: () => {},
  };
  g.document = {
    visibilityState: 'visible',
    addEventListener() {},
    removeEventListener() {},
  };
  g.fetch = (url: string, init?: { method?: string }) => {
    if (url === '/api/qa-runs' && init?.method === 'POST') {
      qaPosts += 1;
      return Promise.resolve(
        okJson({
          id: `qa-run-${qaPosts}`,
          taskId: 't1',
          terminalId: `term-${qaPosts}`,
          cwd: 'C:/scratch',
          command: 'claude',
          serverId: `srv-${qaPosts}`,
        }),
      );
    }
    // Status polls: keep the run "running".
    return Promise.resolve(okJson({ status: 'running' }));
  };
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete g[k];
    else g[k] = v;
  }
});

const task = { id: 't1', title: 'My feature', status: 'qa' } as Task;

type Hook = ReturnType<typeof useQaRuns>;
let latest!: Hook;
let focused: string[] = [];
let errors: string[] = [];

// `openTabs` stands in for the sidebar's terminal list: every terminal the hook
// adds is open unless the test closes it.
function Harness({ openTabs }: { openTabs: { id: string }[] }) {
  latest = useQaRuns(
    'C:/project',
    (spec) => {
      const id = spec.id ?? 'term';
      if (!openTabs.some((t) => t.id === id)) openTabs.push({ id });
      return id;
    },
    () => {},
    (msg) => errors.push(msg),
    { terminals: openTabs, focusTerminal: (id) => focused.push(id) },
  );
  return null;
}

async function flush() {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

test('a second ▶ while the task is under test starts no second session and focuses the first', async () => {
  focused = [];
  errors = [];
  const openTabs: { id: string }[] = [];
  let renderer!: ReturnType<typeof TestRenderer.create>;
  await act(async () => {
    renderer = TestRenderer.create(React.createElement(Harness, { openTabs }));
  });
  await act(async () => {
    await latest.startQaRun(task);
    await flush();
  });
  assert.equal(qaPosts, 1);
  assert.ok(latest.runningTaskIds.has('t1'), 'the card shows the task as under test');

  await act(async () => {
    await latest.startQaRun(task);
    await flush();
  });
  assert.equal(qaPosts, 1, 'apiStartQaRun must be called exactly once');
  assert.deepEqual(focused, ['term-1'], 'the repeat click focuses the running session');
  assert.deepEqual(errors, []);
  act(() => renderer.unmount());
});

test('"run all" skips a task that is already under test', async () => {
  focused = [];
  errors = [];
  const openTabs: { id: string }[] = [];
  let renderer!: ReturnType<typeof TestRenderer.create>;
  await act(async () => {
    renderer = TestRenderer.create(React.createElement(Harness, { openTabs }));
  });
  await act(async () => {
    await latest.startQaRun(task);
    await flush();
  });
  await act(async () => {
    latest.startAllQaRuns([task]);
    await flush();
  });
  assert.equal(qaPosts, 1);
  act(() => renderer.unmount());
});

test('a run whose terminal tab was closed no longer blocks a re-test', async () => {
  focused = [];
  errors = [];
  const openTabs: { id: string }[] = [];
  let renderer!: ReturnType<typeof TestRenderer.create>;
  await act(async () => {
    renderer = TestRenderer.create(React.createElement(Harness, { openTabs }));
  });
  await act(async () => {
    await latest.startQaRun(task);
    await flush();
  });
  // The user closes the QA tab: its pty dies and the run never reports done.
  openTabs.length = 0;
  await act(async () => {
    renderer.update(React.createElement(Harness, { openTabs: [...openTabs] }));
  });
  assert.equal(latest.runningTaskIds.has('t1'), false, 'no "testing…" for a closed tab');

  await act(async () => {
    await latest.startQaRun(task);
    await flush();
  });
  assert.equal(qaPosts, 2, 'a fresh run may start (the backend re-checks the pty)');
  assert.deepEqual(focused, []);
  act(() => renderer.unmount());
});
