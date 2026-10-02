import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import React, { type DragEvent } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import type { Task, TaskStatus } from '../api';
import type { TerminalSpec } from '../terminal/terminalTypes';
import { buildTerminalMap } from '../utils/terminalMap.ts';
import { DRAG_MIME } from '../components/taskboard/lanes.ts';
import type { LaneSortMode } from '../components/taskboard/laneSort.ts';
import { groupTasksByStatus } from '../components/taskboard/hooks/useTaskBoardState.ts';
import { useTaskTerminalFocus } from '../components/taskboard/hooks/useTaskTerminalFocus.ts';
import { useTaskSelection } from '../components/taskboard/hooks/useTaskSelection.ts';
import { useLaneDropTargets } from '../components/taskboard/hooks/useLaneDropTargets.ts';

// Every /ws/tasks frame is a new tasks array (~750 tasks on this repo). The
// card callbacks used to change identity on each one — `getFocusTerminal`
// (terminal map memoized on `tasks`) and `handleRangeSelect` (closed over
// `tasks`/`grouped`/`getLaneSortMode`) — so React.memo(TaskCard) re-rendered
// every card while the board was open, and each drop slot got three fresh
// closures per Lane render. Those identities must now survive a board update
// whose content is unchanged, without changing what the handlers do.

const g = globalThis as unknown as Record<string, unknown>;
let saved: Record<string, unknown>;

beforeEach(() => {
  saved = { IS_REACT_ACT_ENVIRONMENT: g.IS_REACT_ACT_ENVIRONMENT, React: g.React };
  g.IS_REACT_ACT_ENVIRONMENT = true;
  g.React = React;
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete g[k];
    else g[k] = v;
  }
});

function task(id: string, over: Partial<Task> = {}): Task {
  return { id, projectPath: 'C:/proj', title: id, status: 'qa', createdAt: 0, ...over };
}

// A fresh array of fresh-but-identical task objects: what a WS frame delivers.
function cloneAll(tasks: Task[]): Task[] {
  return tasks.map((t) => ({ ...t }));
}

async function mount(element: React.ReactElement) {
  let renderer!: ReturnType<typeof TestRenderer.create>;
  await act(async () => {
    renderer = TestRenderer.create(element);
  });
  return renderer;
}

// ── terminal focus ─────────────────────────────────────────────────────────

const agentTab: TerminalSpec = { id: 'tab-agent', label: 'agent', cwd: 'C:/wt', taskId: 't1' };
const resolverTab: TerminalSpec = { id: 'tab-merge', label: 'merge', cwd: 'C:/wt', taskId: 't1', kind: 'merge' };
const otherTab: TerminalSpec = { id: 'tab-other', label: 'other', cwd: 'C:/wt2', taskId: 't2' };
const shellTab: TerminalSpec = { id: 'tab-shell', label: 'shell', cwd: 'C:/proj' };

test('buildTerminalMap prefers the merge resolver in either order and skips task-less tabs', () => {
  for (const terminals of [
    [agentTab, resolverTab, otherTab, shellTab],
    [resolverTab, agentTab, shellTab, otherTab],
  ]) {
    const map = buildTerminalMap(terminals);
    assert.equal(map.get('t1'), 'tab-merge');
    assert.equal(map.get('t2'), 'tab-other');
    assert.equal(map.size, 2);
  }
});

test('getFocusTerminal keeps its identity across a board update and still focuses the right tab', async () => {
  const tasks = [task('t1', { status: 'ready_to_merge' }), task('t2', { status: 'in_progress' }), task('t3')];
  const terminals = [agentTab, resolverTab, otherTab];
  const activated: string[] = [];
  const setActiveId = (id: string) => activated.push(id);

  let latest!: ReturnType<typeof useTaskTerminalFocus>;
  function Harness(props: { terminals: TerminalSpec[]; tasks: Task[] }) {
    latest = useTaskTerminalFocus(props.terminals, props.tasks, setActiveId);
    return null;
  }

  const renderer = await mount(React.createElement(Harness, { terminals, tasks }));
  const first = latest.getFocusTerminal;

  await act(async () => {
    renderer.update(React.createElement(Harness, { terminals, tasks: cloneAll(tasks) }));
  });
  assert.equal(latest.getFocusTerminal, first, 'a new tasks array must not rebuild getFocusTerminal');

  latest.getFocusTerminal(tasks[0])?.();
  latest.getFocusTerminal(tasks[1])?.();
  assert.deepEqual(activated, ['tab-merge', 'tab-other']);
  assert.equal(latest.getFocusTerminal(tasks[2]), null, 'a task without a terminal has no focus action');

  // A terminal change is what should rebuild it.
  await act(async () => {
    renderer.update(React.createElement(Harness, { terminals: [agentTab, otherTab], tasks }));
  });
  assert.notEqual(latest.getFocusTerminal, first);
  latest.getFocusTerminal(tasks[0])?.();
  assert.equal(activated.at(-1), 'tab-agent');

  await act(async () => {
    renderer.unmount();
  });
});

// ── range select ───────────────────────────────────────────────────────────

// A QA lane whose arrival order (mergedAt) differs from the grouped order:
//   grouped (sortOrder ?? -createdAt):         D, C, B, A
//   'recent' display order (newest mergedAt):  D, A, C, B
const A = task('A', { createdAt: 1, mergedAt: 300 });
const B = task('B', { createdAt: 2, mergedAt: 100 });
const C = task('C', { createdAt: 3, mergedAt: 200 });
const D = task('D', { createdAt: 4, mergedAt: 400 });
const ALL = [A, B, C, D];

type SelectionProps = {
  tasks: Task[];
  grouped: Record<TaskStatus, Task[]>;
  getLaneSortMode: (lane: TaskStatus) => LaneSortMode;
};

let selection!: ReturnType<typeof useTaskSelection>;
function SelectionHarness(props: SelectionProps) {
  selection = useTaskSelection(props.tasks, props.grouped, props.getLaneSortMode);
  return null;
}

const recent = (): LaneSortMode => 'recent';
const selected = () => [...selection.selectedIds].sort();

test('handleRangeSelect keeps its identity across a board update with identical content', async () => {
  const renderer = await mount(
    React.createElement(SelectionHarness, { tasks: ALL, grouped: groupTasksByStatus(ALL), getLaneSortMode: recent }),
  );
  const first = selection.handleRangeSelect;

  const next = cloneAll(ALL);
  await act(async () => {
    renderer.update(
      React.createElement(SelectionHarness, {
        tasks: next,
        grouped: groupTasksByStatus(next),
        getLaneSortMode: () => 'recent',
      }),
    );
  });
  assert.equal(selection.handleRangeSelect, first, 'new tasks/grouped/getLaneSortMode must not rebuild it');

  await act(async () => {
    renderer.unmount();
  });
});

test('range select slices the lane in its visible sort order, using the latest board state', async () => {
  const renderer = await mount(
    React.createElement(SelectionHarness, { tasks: ALL, grouped: groupTasksByStatus(ALL), getLaneSortMode: recent }),
  );

  await act(async () => {
    selection.handleToggleSelect('A', 'qa');
  });
  const anchored = selection.handleRangeSelect;

  // Display order D, A, C, B: the block between A and B is A, C, B (slicing
  // the grouped order D, C, B, A would give only B, A).
  await act(async () => {
    selection.handleRangeSelect('B', 'qa');
  });
  assert.deepEqual(selected(), ['A', 'B', 'C']);

  // A board update switching the lane to manual order (= grouped D, C, B, A):
  // the same callback must read the new sort mode.
  const next = cloneAll(ALL);
  await act(async () => {
    renderer.update(
      React.createElement(SelectionHarness, {
        tasks: next,
        grouped: groupTasksByStatus(next),
        getLaneSortMode: () => 'manual',
      }),
    );
  });
  assert.equal(selection.handleRangeSelect, anchored);
  await act(async () => {
    selection.handleRangeSelect('B', 'qa');
  });
  assert.deepEqual(selected(), ['A', 'B']);

  await act(async () => {
    renderer.unmount();
  });
});

test('range select skips cards the search is hiding', async () => {
  const renderer = await mount(
    React.createElement(SelectionHarness, { tasks: ALL, grouped: groupTasksByStatus(ALL), getLaneSortMode: recent }),
  );
  await act(async () => {
    selection.handleToggleSelect('A', 'qa');
  });

  // A search hides C: the lanes render (and selection slices) the filtered
  // grouping D, A, B — so A..B no longer sweeps in C.
  await act(async () => {
    renderer.update(
      React.createElement(SelectionHarness, {
        tasks: cloneAll(ALL),
        grouped: groupTasksByStatus([A, B, D]),
        getLaneSortMode: recent,
      }),
    );
  });
  await act(async () => {
    selection.handleRangeSelect('B', 'qa');
  });
  assert.deepEqual(selected(), ['A', 'B']);

  // An anchor in another lane resets to the clicked card.
  await act(async () => {
    selection.handleRangeSelect('X', 'open');
  });
  assert.deepEqual(selected(), ['X']);
  assert.equal(selection.selectionLane, 'open');

  await act(async () => {
    renderer.unmount();
  });
});

// ── drop slots ─────────────────────────────────────────────────────────────

type DropCall = [string, ...unknown[]];

function dropCallbacks(calls: DropCall[], tag: string) {
  return {
    onMove: (id: string, status: TaskStatus) => calls.push([`${tag}:move`, id, status]),
    onDropAt: (id: string, status: TaskStatus, index: number) => calls.push([`${tag}:dropAt`, id, status, index]),
    onMultiMove: (ids: string[], status: TaskStatus) => calls.push([`${tag}:multiMove`, ids, status]),
    onMultiDropAt: (ids: string[], status: TaskStatus, index: number) =>
      calls.push([`${tag}:multiDropAt`, ids, status, index]),
  };
}

// A drag event fired at the slot rendered with `data-slot-index={slot}`.
function slotEvent(slot: number, payload = '') {
  const log: string[] = [];
  const dataTransfer = {
    dropEffect: 'none',
    getData: (type: string) => (type === DRAG_MIME ? payload : ''),
  };
  const event = {
    currentTarget: {
      getAttribute: (name: string) => (name === 'data-slot-index' ? String(slot) : null),
    },
    dataTransfer,
    preventDefault: () => log.push('preventDefault'),
    stopPropagation: () => log.push('stopPropagation'),
  } as unknown as DragEvent;
  return { event, log, dataTransfer };
}

let drops!: ReturnType<typeof useLaneDropTargets>;
function DropHarness(props: { draggingId: string | null; callbacks: ReturnType<typeof dropCallbacks> }) {
  drops = useLaneDropTargets('open', props.draggingId, props.callbacks);
  return null;
}

test('slot handlers stay stable across renders and hover moves, and act on the slot index', async () => {
  const calls: DropCall[] = [];
  const renderer = await mount(
    React.createElement(DropHarness, { draggingId: 'X', callbacks: dropCallbacks(calls, 'v1') }),
  );
  const first = drops.slotHandlers;

  // A Lane re-render passes a fresh callbacks object.
  await act(async () => {
    renderer.update(React.createElement(DropHarness, { draggingId: 'X', callbacks: dropCallbacks(calls, 'v2') }));
  });
  assert.equal(drops.slotHandlers, first);

  const enter = slotEvent(2);
  await act(async () => {
    drops.slotHandlers.onDragEnter(enter.event);
  });
  assert.equal(drops.hoverIndex, 2);
  assert.deepEqual(enter.log, ['preventDefault', 'stopPropagation']);

  const over = slotEvent(3);
  await act(async () => {
    drops.slotHandlers.onDragOver(over.event);
  });
  assert.equal(drops.hoverIndex, 3);
  assert.equal(over.dataTransfer.dropEffect, 'move');
  assert.deepEqual(over.log, ['preventDefault', 'stopPropagation']);
  assert.equal(drops.slotHandlers, first, 'a hover move must not rebuild the slot handlers');

  // Single and multi drops land at the slot's index through the LATEST callbacks.
  await act(async () => {
    drops.slotHandlers.onDrop(slotEvent(1, 'X').event);
  });
  assert.equal(drops.hoverIndex, null);
  await act(async () => {
    drops.slotHandlers.onDrop(slotEvent(4, JSON.stringify(['X', 'Y'])).event);
  });
  assert.deepEqual(calls, [
    ['v2:dropAt', 'X', 'open', 1],
    ['v2:multiDropAt', ['X', 'Y'], 'open', 4],
  ]);

  await act(async () => {
    renderer.unmount();
  });
});

test('slot hover is ignored while nothing is being dragged', async () => {
  const calls: DropCall[] = [];
  const renderer = await mount(
    React.createElement(DropHarness, { draggingId: null, callbacks: dropCallbacks(calls, 'v1') }),
  );

  const enter = slotEvent(2);
  const over = slotEvent(2);
  await act(async () => {
    drops.slotHandlers.onDragEnter(enter.event);
    drops.slotHandlers.onDragOver(over.event);
  });
  assert.equal(drops.hoverIndex, null);
  assert.deepEqual(enter.log, []);
  assert.deepEqual(over.log, []);
  assert.equal(over.dataTransfer.dropEffect, 'none');

  await act(async () => {
    renderer.unmount();
  });
});
