import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { FakeWebSocket } from './domDoubles.ts';
import { useTaskList } from '../components/taskboard/hooks/useTaskList.ts';
import type { Task } from '../api';

const g = globalThis as unknown as Record<string, unknown>;
let saved: Record<string, unknown>;

function task(id: string, projectPath: string): Task {
  return {
    id,
    projectPath,
    title: `${projectPath} task ${id}`,
    status: 'open',
    createdAt: 1,
    updatedAt: 1,
  };
}

function responseFor(tasks: Task[]) {
  return {
    ok: true,
    json: () =>
      Promise.resolve({
        project: tasks[0]?.projectPath ?? '',
        canonicalProject: tasks[0]?.projectPath ?? '',
        hash: 'hash',
        count: tasks.length,
        mismatched: 0,
        tasks,
      }),
  };
}

beforeEach(() => {
  FakeWebSocket.instances = [];
  saved = {
    IS_REACT_ACT_ENVIRONMENT: g.IS_REACT_ACT_ENVIRONMENT,
    React: g.React,
    WebSocket: g.WebSocket,
    window: g.window,
    document: g.document,
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
  g.document = { addEventListener() {}, removeEventListener() {} };
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete g[k];
    else g[k] = v;
  }
});

async function flush() {
  for (let i = 0; i < 6; i++) await Promise.resolve();
}

function Harness({ folder, onAction }: { folder: string; onAction: (id: string) => void }) {
  const { tasks } = useTaskList(folder);
  return React.createElement(
    'div',
    null,
    tasks.map((t) =>
      React.createElement(
        'button',
        { key: t.id, onClick: () => onAction(t.id) },
        t.id,
      ),
    ),
  );
}

test("switching projects hides project A's task cards while project B fetch is delayed", async () => {
  let resolveB!: (value: unknown) => void;
  const bFetch = new Promise((res) => {
    resolveB = res;
  });
  const aTasks = [task('A-1', 'C:/project-A')];
  const bTasks = [task('B-1', 'C:/project-B')];
  const actions: string[] = [];

  g.fetch = (url: string) => {
    if (url.includes('/api/tasks?')) {
      const decoded = decodeURIComponent(url);
      if (decoded.includes('C:/project-A')) return Promise.resolve(responseFor(aTasks));
      if (decoded.includes('C:/project-B')) return bFetch;
    }
    return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) });
  };

  let renderer!: ReturnType<typeof TestRenderer.create>;
  const tree = (folder: string) =>
    React.createElement(Harness, { folder, onAction: (id) => actions.push(id) });

  await act(async () => {
    renderer = TestRenderer.create(tree('C:/project-A'));
  });
  await act(async () => {
    await flush();
  });
  assert.deepEqual(
    renderer.root.findAllByType('button').map((b) => b.children.join('')),
    ['A-1'],
  );

  await act(async () => {
    renderer.update(tree('C:/project-B'));
  });

  assert.deepEqual(
    renderer.root.findAllByType('button').map((b) => b.children.join('')),
    [],
    "A's card must not remain rendered/actionable under project B while B loads",
  );

  resolveB(responseFor(bTasks));
  await act(async () => {
    await flush();
  });
  const buttons = renderer.root.findAllByType('button');
  assert.deepEqual(buttons.map((b) => b.children.join('')), ['B-1']);

  act(() => {
    buttons[0].props.onClick();
  });
  assert.deepEqual(actions, ['B-1'], 'only B task ids are actionable after switch');

  act(() => renderer.unmount());
});
