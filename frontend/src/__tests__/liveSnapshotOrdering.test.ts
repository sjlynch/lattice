import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { FakeWebSocket, installFakeWebSocket, installGlobal, installWindow } from './domDoubles.ts';
import { useMergeRunSync } from '../components/taskboard/hooks/useMergeRunSync.ts';
import { usePostMergeHook } from '../components/taskboard/hooks/usePostMergeHook.ts';
import { useTaskList } from '../components/taskboard/hooks/useTaskList.ts';
import type { MergeRun, Task } from '../api';

const project = 'C:/snapshot-ordering';
const addTerminal = () => '';
const noop = () => {};
const run: MergeRun = {
  id: 'merge-1', projectPath: project, status: 'running', startedAt: 1,
  total: 1, processed: 0, merged: [], conflicted: [], errored: [], cancelRequested: false,
};

async function scenario(
  t: TestContext,
  path: string,
  hook: () => unknown,
) {
  let resolve!: (value: unknown) => void;
  const pending = new Promise((res) => { resolve = res; });
  const restore = [
    installGlobal('IS_REACT_ACT_ENVIRONMENT', true),
    installWindow({ location: { protocol: 'http:', host: 'localhost:5184' } }),
    installFakeWebSocket(),
    installGlobal('fetch', (url: string) => Promise.resolve({
      ok: true,
      json: () => url.includes(path) ? pending : Promise.resolve({}),
    })),
  ];
  let latest: unknown;
  function Harness() { latest = hook(); return null; }
  let renderer!: ReturnType<typeof TestRenderer.create>;
  await act(async () => { renderer = TestRenderer.create(React.createElement(Harness)); });
  t.after(() => {
    act(() => renderer.unmount());
    for (const reset of restore.reverse()) reset();
  });
  return {
    current: () => latest,
    send: async (event: unknown) => {
      await act(async () => {
        FakeWebSocket.instances[0].onmessage?.({ data: JSON.stringify(event) });
      });
    },
    finishFetch: async (body: unknown) => {
      await act(async () => { resolve(body); });
    },
  };
}

test('late HTTP idle cannot hide a merge run started on WebSocket', async (t) => {
  const s = await scenario(t, '/api/merge-runs/active', () =>
    useMergeRunSync(project, addTerminal, noop).mergeRun);
  await s.send({ type: 'started', run });
  assert.deepEqual(s.current(), run);
  await s.finishFetch(null);
  assert.deepEqual(s.current(), run);
});

test('late HTTP running snapshot cannot resurrect a completed merge run', async (t) => {
  const s = await scenario(t, '/api/merge-runs/active', () =>
    useMergeRunSync(project, addTerminal, noop).mergeRun);
  await s.send({ type: 'completed', run: { ...run, status: 'completed', processed: 1 } });
  await s.finishFetch(run);
  assert.equal(s.current(), null);
});

test('late task fetch cannot move a merged task from QA back to In Progress', async (t) => {
  const s = await scenario(t, '/api/tasks?', () => useTaskList(project).tasks);
  const task: Task = { id: 'task-1', projectPath: project, title: 'Task', status: 'qa', createdAt: 1, updatedAt: 3 };
  await s.send({ type: 'tasks', tasks: [task] });
  assert.deepEqual(s.current(), [task]);
  await s.finishFetch({ tasks: [{ ...task, status: 'in_progress', updatedAt: 2 }] });
  assert.deepEqual(s.current(), [task]);
});

test('late HTTP snapshot cannot resurrect a finished post-merge hook', async (t) => {
  const s = await scenario(t, '/api/post-merge-hooks/active', () =>
    usePostMergeHook(project, addTerminal, noop).active);
  const hookRun = { id: 'hook-1', projectPath: project, status: 'running', startedAt: 1, cwd: project };
  await s.send({ type: 'finished', run: { ...hookRun, status: 'done' } });
  await s.finishFetch({ active: hookRun, recent: null });
  assert.equal(s.current(), null);
});
