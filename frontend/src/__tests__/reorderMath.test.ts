import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Task } from '../api';
import { sortTasksForLane } from '../components/taskboard/laneSort.ts';
import { groupTasksByStatus } from '../components/taskboard/hooks/useTaskBoardState.ts';
import {
  appendOrder,
  multiDropOrder,
  selectedTasksInVisibleOrder,
  singleDropOrder,
} from '../components/taskboard/reorderMath.ts';
import { compareTasksForLane } from '../components/taskboard/hooks/useTaskBoardState.ts';

function task(id: string, over: Partial<Task> = {}): Task {
  return {
    id,
    projectPath: 'C:/proj',
    title: id,
    status: 'in_progress',
    createdAt: 0,
    ...over,
  };
}

// An In-Progress lane whose *arrival* order (startedAt) deliberately differs
// from the sortOrder ?? -createdAt grouping. This is the exact shape that broke
// drag-to-reorder: the slot index is measured against the visible (arrival-
// sorted) order, but the old code spliced into the grouped order.
//
//   grouped order (sortOrder ?? -createdAt, newest createdAt first): C, B, A
//   'recent' display order (startedAt, newest arrival first):        A, C, B
const A = task('A', { createdAt: 1, startedAt: 300 });
const B = task('B', { createdAt: 2, startedAt: 100 });
const C = task('C', { createdAt: 3, startedAt: 200 });

function displayedInProgress(): Task[] {
  const grouped = groupTasksByStatus([A, B, C]);
  return sortTasksForLane(grouped.in_progress, 'in_progress', 'recent');
}

test('fixture: display order differs from grouped order', () => {
  assert.deepEqual(
    groupTasksByStatus([A, B, C]).in_progress.map((t) => t.id),
    ['C', 'B', 'A'],
  );
  assert.deepEqual(displayedInProgress().map((t) => t.id), ['A', 'C', 'B']);
});

test('single drop lands at the visible slot (recent sort ≠ createdAt order)', () => {
  // Visible: [A, C, B]. Drop B into slot 1 (between A and C).
  const order = singleDropOrder(displayedInProgress(), B, 'in_progress', 1);
  assert.deepEqual(order, ['A', 'B', 'C']);
  // B now sits at index 1 — exactly the slot the drop indicator showed.
  assert.equal(order!.indexOf('B'), 1);
});

test('single drop to the end slot lands last', () => {
  // Visible: [A, C, B]. Drop A into slot 3 (after B).
  const order = singleDropOrder(displayedInProgress(), A, 'in_progress', 3);
  assert.deepEqual(order, ['C', 'B', 'A']);
});

test('regression: the old grouped-order math would mis-place the card', () => {
  // The pre-fix code spliced into grouped order [C, B, A]. Dropping B at slot 1
  // (which the user measured against the *visible* [A, C, B]) collapses to a
  // no-op there because B is already at grouped index 1 — so the card never
  // moved to where it was dropped.
  const grouped = groupTasksByStatus([A, B, C]).in_progress;
  const buggy = singleDropOrder(grouped, B, 'in_progress', 1);
  assert.equal(buggy, null);
  // The fixed path (against the visible order) actually moves it.
  assert.notEqual(singleDropOrder(displayedInProgress(), B, 'in_progress', 1), null);
});

test('single drop onto its own current slot is a no-op', () => {
  // Visible: [A, C, B]. A is at index 0; dropping it into slot 0 changes nothing.
  assert.equal(singleDropOrder(displayedInProgress(), A, 'in_progress', 0), null);
});

test('multi drop lands the group at the visible slot', () => {
  // Visible: [A, C, B]. Drag A and B, drop into slot 2 (after C).
  const order = multiDropOrder(displayedInProgress(), [A, B], ['A', 'B'], 2);
  assert.deepEqual(order, ['C', 'A', 'B']);
});

test('append moves preserve the lane and tack the group on the end', () => {
  const order = appendOrder(displayedInProgress(), [B], ['B']);
  assert.deepEqual(order, ['A', 'C', 'B']);
});

test('cross-lane single drop inserts a foreign task at the visible slot', () => {
  // A task arriving from another lane isn't in the destination's visible order;
  // it should land precisely at the dropped slot.
  const incoming = task('X', { status: 'ready_to_merge' });
  const order = singleDropOrder(displayedInProgress(), incoming, 'in_progress', 2);
  assert.deepEqual(order, ['A', 'C', 'X', 'B']);
});

// An 'oldest'-sorted lane shows tasks by arrival ascending — here [B, C, A],
// the reverse of compareTasksForLane's (sortOrder ?? -createdAt) order [C, B, A].
function displayedOldestInProgress(): Task[] {
  const grouped = groupTasksByStatus([A, B, C]);
  return sortTasksForLane(grouped.in_progress, 'in_progress', 'oldest');
}

test('fixture: oldest display order is the reverse of grouped order', () => {
  assert.deepEqual(displayedOldestInProgress().map((t) => t.id), ['B', 'C', 'A']);
});

test('multi-drag block keeps the visible order, not sortOrder/createdAt order', () => {
  // Visible (oldest): [B, C, A]. Select B and C — visibly B sits above C.
  const srcTasks = selectedTasksInVisibleOrder(displayedOldestInProgress(), [
    'B',
    'C',
  ]);
  assert.deepEqual(srcTasks.map((t) => t.id), ['B', 'C']);
  // Drop the pair at the end of the lane.
  const order = multiDropOrder(displayedOldestInProgress(), srcTasks, ['B', 'C'], 3);
  // B stays above C, matching what the user saw.
  assert.deepEqual(order, ['A', 'B', 'C']);
});

test('regression: the old grouped-sort block would land the pair reversed', () => {
  // The pre-fix code built the moved block via ids.map(find).sort(
  // compareTasksForLane), i.e. sortOrder ?? -createdAt → [C, B] for these two,
  // the REVERSE of the visible [B, C]. Splicing that in persists C above B.
  const buggyBlock = ['B', 'C']
    .map((id) => [A, B, C].find((t) => t.id === id)!)
    .sort(compareTasksForLane);
  assert.deepEqual(buggyBlock.map((t) => t.id), ['C', 'B']);
  const buggyOrder = multiDropOrder(
    displayedOldestInProgress(),
    buggyBlock,
    ['B', 'C'],
    3,
  );
  assert.deepEqual(buggyOrder, ['A', 'C', 'B']);
  // The fixed path preserves the visible order instead.
  const fixedBlock = selectedTasksInVisibleOrder(displayedOldestInProgress(), [
    'B',
    'C',
  ]);
  assert.notDeepEqual(
    multiDropOrder(displayedOldestInProgress(), fixedBlock, ['B', 'C'], 3),
    buggyOrder,
  );
});
