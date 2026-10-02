import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { FakeWebSocket, installFakeWebSocket, installGlobal, installWindow } from './domDoubles.ts';
import { useTaskList } from '../components/taskboard/hooks/useTaskList.ts';
import { subscribeTasks, type Task, type TaskSpawnedEvent } from '../api';

// `/ws/tasks` caches only the in-progress tasks (flagged `partial`) for a late
// joiner, so the board never receives a full replayed snapshot. A partial
// update must neither replace the board nor suppress the board's own HTTP fetch.

const project = 'C:/partial-replay';

function task(id: string, status: Task['status']): Task {
  return { id, projectPath: project, title: `Task ${id}`, status, createdAt: 1, updatedAt: 1 };
}

const board = [task('open-1', 'open'), task('run-1', 'in_progress'), task('done-1', 'done')];
const fetchedBoard = [...board, task('open-2', 'open')];

async function scenario(t: TestContext) {
  const fetches: ((tasks: Task[]) => void)[] = [];
  const restore = [
    installGlobal('IS_REACT_ACT_ENVIRONMENT', true),
    installWindow({ location: { protocol: 'http:', host: 'localhost:5184' } }),
    installFakeWebSocket(),
    installGlobal('fetch', (url: string) => {
      assert.ok(url.includes('/api/tasks?'), `unexpected fetch ${url}`);
      return new Promise((resolve) => {
        fetches.push((tasks) => resolve({ ok: true, json: () => Promise.resolve({ tasks }) }));
      });
    }),
  ];
  // The graph's agent overlay, already holding the shared socket open.
  const graphUpdates: { ids: string[]; partial: boolean }[] = [];
  const stopGraph = subscribeTasks(project, (tasks, { partial }) => {
    graphUpdates.push({ ids: tasks.map((x) => x.id), partial });
  });
  const socket = FakeWebSocket.instances[0];
  socket.serverAccept();

  let latest: Task[] = [];
  function Harness({ onSpawned }: { onSpawned: (event: TaskSpawnedEvent) => void }) {
    latest = useTaskList(project, onSpawned).tasks;
    return null;
  }
  let renderer: ReturnType<typeof TestRenderer.create> | undefined;
  t.after(() => {
    if (renderer) act(() => renderer!.unmount());
    stopGraph();
    for (const reset of restore.reverse()) reset();
  });
  return {
    graphUpdates,
    current: () => latest,
    ids: () => latest.map((x) => x.id),
    render: async (onSpawned: (event: TaskSpawnedEvent) => void) => {
      await act(async () => {
        const element = React.createElement(Harness, { onSpawned });
        if (renderer) renderer.update(element);
        else renderer = TestRenderer.create(element);
      });
    },
    sendBoard: async (tasks: Task[]) => {
      await act(async () => {
        socket.onmessage?.({ data: JSON.stringify({ type: 'tasks', tasks }) });
      });
    },
    finishFetch: async (index: number, tasks: Task[]) => {
      await act(async () => { fetches[index](tasks); });
    },
    fetchCount: () => fetches.length,
  };
}

test('a late-joining board ignores the partial replay and loads its own fetch', async (t) => {
  const s = await scenario(t);
  await s.sendBoard(board);
  assert.deepEqual(s.graphUpdates, [{ ids: ['open-1', 'run-1', 'done-1'], partial: false }]);

  await s.render(() => {});
  assert.deepEqual(s.ids(), [], 'the in-progress-only replay is not rendered as the board');

  await s.finishFetch(0, fetchedBoard);
  assert.deepEqual(s.ids(), ['open-1', 'run-1', 'done-1', 'open-2'],
    'the partial replay did not count as live state, so the fetch still lands');
});

test('a partial replay on resubscribe leaves a populated board unchanged', async (t) => {
  const s = await scenario(t);
  await s.render(() => {});
  await s.finishFetch(0, board);
  await s.sendBoard(board);
  const populated = s.current();
  assert.deepEqual(s.ids(), ['open-1', 'run-1', 'done-1']);

  // A new spawn handler re-runs the subscription effect: the board re-joins the
  // already-open channel as a late joiner and is handed the partial replay.
  await s.render(() => {});
  assert.equal(s.fetchCount(), 2, 'the resubscribe refetches the whole board');
  assert.equal(s.current(), populated, 'the partial replay does not replace the board');

  await s.finishFetch(1, fetchedBoard);
  assert.deepEqual(s.ids(), ['open-1', 'run-1', 'done-1', 'open-2']);
});
