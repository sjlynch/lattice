// The board controller stays mounted (TaskBoardLauncher), so its derivations
// run on every `/ws/tasks` frame. They were rewritten to stop allocating per
// task per frame — a cached search haystack, the existing grouping reused while
// search is off, a terminal-indexed cleanup pass, a strip index built only
// while a strip exists, and a reattach key skipped once its one-shot ran. These
// pin that the results are exactly what the old allocation-heavy code produced.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import type { Task } from '../api';
import type { TerminalSpec } from '../TerminalsContext';
import { useTaskSearch } from '../components/taskboard/hooks/useTaskSearch.ts';
import {
  groupTasksByStatus,
  type GroupedTasks,
} from '../components/taskboard/hooks/useTaskBoardState.ts';
import { useTaskTerminalCleanup } from '../components/taskboard/hooks/useTaskTerminalCleanup.ts';
import { useBulkRunStrips } from '../components/taskboard/hooks/useBulkRunStrips.ts';
import { useTaskTerminalReattach } from '../components/taskboard/hooks/useTaskTerminalReattach.ts';
import { installManualTimers, type ManualTimers } from './domDoubles.ts';

const g = globalThis as unknown as Record<string, unknown>;
let saved: Record<string, unknown>;
let timers: ManualTimers;

beforeEach(() => {
  saved = {
    IS_REACT_ACT_ENVIRONMENT: g.IS_REACT_ACT_ENVIRONMENT,
    React: g.React,
    fetch: g.fetch,
  };
  g.IS_REACT_ACT_ENVIRONMENT = true;
  g.React = React;
  timers = installManualTimers();
});

afterEach(() => {
  timers.restore();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete g[k];
    else g[k] = v;
  }
});

async function flush() {
  for (let i = 0; i < 6; i++) await Promise.resolve();
}

const ids = (tasks: Task[]) => tasks.map((t) => t.id);
const groupedIds = (grouped: GroupedTasks) =>
  Object.fromEntries(
    Object.entries(grouped).map(([status, tasks]) => [status, ids(tasks)]),
  );

// ── useTaskSearch ───────────────────────────────────────────────────────────

// The pre-cache matcher, verbatim: rebuild + lowercase the haystack each call.
function referenceSearch(tasks: Task[], query: string): Task[] {
  const q = query.trim().toLowerCase();
  if (q.length === 0) return tasks;
  return tasks.filter((t) =>
    `${t.title}\n${t.description ?? ''}\n${t.summary ?? ''}`
      .toLowerCase()
      .includes(q),
  );
}

function searchTask(
  id: string,
  status: Task['status'],
  title: string,
  description?: string,
  summary?: string,
): Task {
  return { id, status, title, description, summary, projectPath: 'C:/p', createdAt: 1 };
}

const SEARCH_TASKS: Task[] = [
  searchTask('a', 'open', 'Fix Merge Pipeline', 'Touches the RESOLVER'),
  searchTask('b', 'qa', 'graph labels', undefined, 'Added Alt-key LABELS overlay'),
  searchTask('c', 'done', 'Straße Ünïcode', 'mixed CaSe text', 'Merged cleanly'),
  searchTask('d', 'in_progress', 'plain'),
  searchTask('e', 'open', 'undefined behaviour', 'null pointer'),
];

let search!: ReturnType<typeof useTaskSearch>;
function SearchHarness({ tasks, grouped }: { tasks: Task[]; grouped?: GroupedTasks }) {
  search = useTaskSearch(tasks, grouped);
  return null;
}

test('search matches case-insensitively across title, description and summary, as before', async () => {
  const grouped = groupTasksByStatus(SEARCH_TASKS);
  let renderer!: ReturnType<typeof TestRenderer.create>;
  await act(async () => {
    renderer = TestRenderer.create(
      React.createElement(SearchHarness, { tasks: SEARCH_TASKS, grouped }),
    );
  });
  const queries = [
    'merge', 'MERGE', '  resolver  ', 'labels', 'ALT-KEY', 'straße', 'ÜNÏCODE',
    'case text', 'undefined', 'null', 'pipeline\ntouches', 'graph labels\n\nadded',
    'plain\n\n', 'zzz', '',
  ];
  // Twice over: the second pass is served from the haystack cache.
  for (const pass of [1, 2]) {
    for (const query of queries) {
      await act(async () => { search.setTaskSearch(query); });
      const expected = referenceSearch(SEARCH_TASKS, query);
      assert.deepEqual(ids(search.filteredTasks), ids(expected), `pass ${pass}: ${JSON.stringify(query)}`);
      assert.deepEqual(groupedIds(search.filteredGrouped), groupedIds(groupTasksByStatus(expected)));
      assert.equal(search.searchActive, query.trim().length > 0);
    }
  }
  act(() => renderer.unmount());
});

test('an edited task (new object) is searched by its new text, not a cached one', async () => {
  let renderer!: ReturnType<typeof TestRenderer.create>;
  await act(async () => {
    renderer = TestRenderer.create(React.createElement(SearchHarness, { tasks: SEARCH_TASKS }));
  });
  await act(async () => { search.setTaskSearch('merge'); });
  assert.deepEqual(ids(search.filteredTasks), ['a', 'c']);

  // useTaskList hands back a new Task object for anything that changed.
  const edited = SEARCH_TASKS.map((t) =>
    t.id === 'a' ? { ...t, title: 'Fix graph', description: 'unrelated' }
      : t.id === 'd' ? { ...t, summary: 'now MERGE related' }
        : t,
  );
  await act(async () => {
    renderer.update(React.createElement(SearchHarness, { tasks: edited }));
  });
  assert.deepEqual(ids(search.filteredTasks), ids(referenceSearch(edited, 'merge')));
  assert.deepEqual(ids(search.filteredTasks), ['c', 'd']);
  act(() => renderer.unmount());
});

test('with search off the existing grouping is reused rather than rebuilt', async () => {
  const grouped = groupTasksByStatus(SEARCH_TASKS);
  let renderer!: ReturnType<typeof TestRenderer.create>;
  await act(async () => {
    renderer = TestRenderer.create(
      React.createElement(SearchHarness, { tasks: SEARCH_TASKS, grouped }),
    );
  });
  assert.equal(search.filteredTasks, SEARCH_TASKS);
  assert.equal(search.filteredGrouped, grouped);

  await act(async () => { search.setTaskSearch('merge'); });
  assert.notEqual(search.filteredGrouped, grouped, 'an active search groups the filtered list');
  assert.deepEqual(groupedIds(search.filteredGrouped), groupedIds(groupTasksByStatus(referenceSearch(SEARCH_TASKS, 'merge'))));

  await act(async () => { search.setTaskSearch('   '); });
  assert.equal(search.filteredGrouped, grouped, 'a blank search is off again');

  // A caller that passes no grouping still gets one built from `tasks`.
  await act(async () => {
    renderer.update(React.createElement(SearchHarness, { tasks: SEARCH_TASKS }));
  });
  assert.deepEqual(groupedIds(search.filteredGrouped), groupedIds(grouped));
  act(() => renderer.unmount());
});

// ── useTaskTerminalCleanup ──────────────────────────────────────────────────

// The pre-index cleanup, verbatim: one filter + map per finalized task.
function referenceCleanupBatches(tasks: Task[], terminals: TerminalSpec[]): string[][] {
  const batches: string[][] = [];
  for (const task of tasks) {
    const finalized = task.status === 'qa' || task.status === 'done' || task.status === 'deleted';
    if (!finalized && task.status !== 'ready_to_merge') continue;
    const toClose = terminals
      .filter((terminal) => terminal.taskId === task.id && !terminal.closeState
        && (finalized || terminal.kind !== 'merge'))
      .map((terminal) => terminal.id);
    if (toClose.length > 0) batches.push(toClose);
  }
  return batches;
}

const STATUSES: Task['status'][] = ['backlog', 'open', 'in_progress', 'ready_to_merge', 'qa', 'done', 'deleted'];

const CLEANUP_TASKS: Task[] = STATUSES.map((status) => ({
  id: `t-${status}`, status, title: status, projectPath: 'C:/p', createdAt: 1,
}));

// Every kind × close state for every task, plus tabs with no or an unknown
// task, interleaved so a task's tabs are not contiguous.
const CLEANUP_TERMINALS: TerminalSpec[] = (() => {
  const out: TerminalSpec[] = [];
  const kinds: TerminalSpec['kind'][] = [undefined, 'merge', 'startup'];
  const closeStates: TerminalSpec['closeState'][] = [undefined, 'closing', 'failed'];
  for (const kind of kinds) {
    for (const closeState of closeStates) {
      for (const taskId of [...CLEANUP_TASKS.map((t) => t.id), 'ghost', undefined]) {
        const id = `${taskId ?? 'none'}:${kind ?? 'agent'}:${closeState ?? 'live'}`;
        out.push({ id, label: id, cwd: 'C:/p', taskId, kind, closeState });
      }
    }
  }
  return out;
})();

let closeCalls: string[][] = [];
const recordClose = (ids: string[]) => { closeCalls.push([...ids]); };
function CleanupHarness({ tasks, terminals }: { tasks: Task[]; terminals: TerminalSpec[] }) {
  useTaskTerminalCleanup(tasks, terminals, recordClose);
  return null;
}

test('cleanup closes exactly the old terminal ids, in the same per-task batches and order', async () => {
  const scenarios: Array<[string, Task[], TerminalSpec[]]> = [
    ['all statuses', CLEANUP_TASKS, CLEANUP_TERMINALS],
    ['reversed tasks', [...CLEANUP_TASKS].reverse(), CLEANUP_TERMINALS],
    ['reversed terminals', CLEANUP_TASKS, [...CLEANUP_TERMINALS].reverse()],
    ['every other terminal', CLEANUP_TASKS, CLEANUP_TERMINALS.filter((_, i) => i % 2 === 0)],
    ['no terminals', CLEANUP_TASKS, []],
    ['no tasks', [], CLEANUP_TERMINALS],
    ['only closing/failed tabs', CLEANUP_TASKS, CLEANUP_TERMINALS.filter((t) => t.closeState)],
    ['only in-flight tasks', CLEANUP_TASKS.filter((t) => t.status === 'in_progress' || t.status === 'open'), CLEANUP_TERMINALS],
    ['duplicate task snapshot', [...CLEANUP_TASKS, CLEANUP_TASKS[4]!], CLEANUP_TERMINALS],
  ];
  closeCalls = [];
  let renderer!: ReturnType<typeof TestRenderer.create>;
  await act(async () => {
    renderer = TestRenderer.create(React.createElement(CleanupHarness, { tasks: [], terminals: [] }));
  });
  assert.deepEqual(closeCalls, []);
  for (const [name, tasks, terminals] of scenarios) {
    closeCalls = [];
    await act(async () => {
      renderer.update(React.createElement(CleanupHarness, { tasks, terminals }));
    });
    assert.deepEqual(closeCalls, referenceCleanupBatches(tasks, terminals), name);
  }
  // Sanity: the full matrix exercises both rules (resolvers spared only at
  // ready-to-merge) and skips every closing/failed tab.
  closeCalls = [];
  await act(async () => {
    renderer.update(React.createElement(CleanupHarness, { tasks: CLEANUP_TASKS, terminals: [...CLEANUP_TERMINALS] }));
  });
  assert.deepEqual(closeCalls, [
    ['t-ready_to_merge:agent:live', 't-ready_to_merge:startup:live'],
    ['t-qa:agent:live', 't-qa:merge:live', 't-qa:startup:live'],
    ['t-done:agent:live', 't-done:merge:live', 't-done:startup:live'],
    ['t-deleted:agent:live', 't-deleted:merge:live', 't-deleted:startup:live'],
  ]);
  act(() => renderer.unmount());
});

// ── useBulkRunStrips ────────────────────────────────────────────────────────

let strips!: ReturnType<typeof useBulkRunStrips>;
function StripHarness({ tasks }: { tasks: Task[] }) {
  strips = useBulkRunStrips('C:/p', tasks);
  return null;
}

function stripTask(id: string, status: Task['status'], runQueued?: boolean): Task {
  return { id, status, runQueued } as Task;
}

test('a strip begun after record-less task updates classifies against the current tasks', async () => {
  let renderer!: ReturnType<typeof TestRenderer.create>;
  await act(async () => {
    renderer = TestRenderer.create(
      React.createElement(StripHarness, { tasks: [stripTask('o1', 'open')] }),
    );
  });
  const idle = strips.bulkStrips;
  // Frames with no strip record do no per-task work.
  await act(async () => {
    renderer.update(React.createElement(StripHarness, {
      tasks: [stripTask('o1', 'open'), stripTask('o2', 'open')],
    }));
  });
  assert.equal(strips.bulkStrips, idle);
  assert.deepEqual(strips.bulkStrips, {});

  // Both targets are still Open: pending, not "spawned" against an empty index.
  await act(async () => { strips.beginBulk('open', ['o1', 'o2'], 'run'); });
  assert.deepEqual(strips.bulkStrips.open, { kind: 'run', phase: 'active', total: 2, spawned: 0, queued: 0 });

  await act(async () => {
    renderer.update(React.createElement(StripHarness, {
      tasks: [stripTask('o1', 'in_progress'), stripTask('o2', 'open')],
    }));
  });
  assert.deepEqual(strips.bulkStrips.open, { kind: 'run', phase: 'active', total: 2, spawned: 1, queued: 0 });

  await act(async () => {
    renderer.update(React.createElement(StripHarness, {
      tasks: [stripTask('o1', 'in_progress'), stripTask('o2', 'open', true)],
    }));
  });
  assert.deepEqual(strips.bulkStrips.open, { kind: 'run', phase: 'done', total: 2, spawned: 1, queued: 1 });

  await act(async () => { timers.fireAll(); });
  assert.deepEqual(strips.bulkStrips, {});
  act(() => renderer.unmount());
});

// ── useTaskTerminalReattach ─────────────────────────────────────────────────

function reattachTask(id: string, projectPath: string): Task {
  return {
    id, projectPath, title: id, status: 'in_progress', createdAt: 1, worktreePath: `C:/wt/${id}`,
  };
}

function ReattachHarness({ folder, tasks, addTerminal }: {
  folder: string;
  tasks: Task[];
  addTerminal: (spec: Omit<TerminalSpec, 'id'>) => string;
}) {
  useTaskTerminalReattach(folder, tasks, [], addTerminal);
  return null;
}

test('the reattach one-shot fires on the same occasions once its key is short-circuited', async () => {
  let calls = 0;
  g.fetch = (url: string) => {
    assert.equal(url, '/api/terminals');
    calls += 1;
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve(['a1', 'a2', 'b1'].map((id) => ({ id: `pty-${id}`, cwd: `C:/wt/${id}` }))),
    });
  };
  const added: string[] = [];
  const addTerminal = (spec: Omit<TerminalSpec, 'id'>) => {
    added.push(spec.serverId!);
    return `term-${added.length}`;
  };
  const render = (folder: string, tasks: Task[]) =>
    React.createElement(ReattachHarness, { folder, tasks, addTerminal });

  let renderer!: ReturnType<typeof TestRenderer.create>;
  // Waits for the folder's tasks to load before its one attempt.
  await act(async () => { renderer = TestRenderer.create(render('C:/A', [])); await flush(); });
  assert.equal(calls, 0);
  await act(async () => { renderer.update(render('C:/A', [reattachTask('a1', 'C:/A')])); await flush(); });
  assert.equal(calls, 1);
  assert.deepEqual(added, ['pty-a1']);

  // After the one-shot, even a changed in-progress set never polls again.
  for (const tasks of [
    [reattachTask('a1', 'C:/A'), reattachTask('a2', 'C:/A')],
    [reattachTask('a2', 'C:/A')],
    [],
  ]) {
    await act(async () => { renderer.update(render('C:/A', tasks)); await flush(); });
  }
  assert.equal(calls, 1);
  assert.equal(timers.scheduled.length, 0);

  // A project switch arms it again, and so does switching back.
  await act(async () => { renderer.update(render('C:/B', [reattachTask('b1', 'C:/B')])); await flush(); });
  assert.equal(calls, 2);
  assert.deepEqual(added, ['pty-a1', 'pty-b1']);
  await act(async () => { renderer.update(render('C:/A', [reattachTask('a2', 'C:/A')])); await flush(); });
  assert.equal(calls, 3);
  assert.deepEqual(added, ['pty-a1', 'pty-b1', 'pty-a2']);
  act(() => renderer.unmount());
});
