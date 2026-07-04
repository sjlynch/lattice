import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Task } from '../api';
import { sortTasksForLane } from '../components/taskboard/laneSort.ts';
import { groupTasksByStatus } from '../components/taskboard/hooks/useTaskBoardState.ts';
import { rangeSelectedIds } from '../components/taskboard/hooks/useTaskSelection.ts';

function task(id: string, over: Partial<Task> = {}): Task {
  return {
    id,
    projectPath: 'C:/proj',
    title: id,
    status: 'qa',
    createdAt: 0,
    ...over,
  };
}

// A QA lane whose *arrival* order (mergedAt) deliberately differs from the
// sortOrder ?? -createdAt grouping — the exact shape that broke shift-range
// selection: the cards render in arrival order, but the old code sliced the
// grouped order.
//
//   grouped order (sortOrder ?? -createdAt, newest createdAt first): D, C, B, A
//   'recent' display order (mergedAt, newest arrival first):         D, A, C, B
const A = task('A', { createdAt: 1, mergedAt: 300 });
const B = task('B', { createdAt: 2, mergedAt: 100 });
const C = task('C', { createdAt: 3, mergedAt: 200 });
const D = task('D', { createdAt: 4, mergedAt: 400 });

function displayedQa(): Task[] {
  const grouped = groupTasksByStatus([A, B, C, D]);
  return sortTasksForLane(grouped.qa, 'qa', 'recent');
}

test('fixture: display order differs from grouped order', () => {
  assert.deepEqual(
    groupTasksByStatus([A, B, C, D]).qa.map((t) => t.id),
    ['D', 'C', 'B', 'A'],
  );
  assert.deepEqual(displayedQa().map((t) => t.id), ['D', 'A', 'C', 'B']);
});

test('shift-range selects the visible-order block (recent sort ≠ createdAt order)', () => {
  // Visible: [D, A, C, B]. Anchor A, shift-click C → the block shown between
  // them is [A, C].
  assert.deepEqual(rangeSelectedIds(displayedQa(), 'A', 'C'), ['A', 'C']);
});

test('shift-range is symmetric regardless of which endpoint is the anchor', () => {
  // Anchoring on C and shift-clicking A yields the same block.
  assert.deepEqual(rangeSelectedIds(displayedQa(), 'C', 'A'), ['A', 'C']);
});

test('regression: the old grouped-order math would select a different block', () => {
  // The pre-fix code sliced the grouped order [D, C, B, A]. Anchor A (grouped
  // index 3), target C (grouped index 1) → [C, B, A] — three cards, none of
  // which is the [A, C] the user saw highlighted between anchor and target.
  const grouped = groupTasksByStatus([A, B, C, D]).qa;
  assert.deepEqual(rangeSelectedIds(grouped, 'A', 'C'), ['C', 'B', 'A']);
  // The fixed path slices the visible order instead.
  assert.notDeepEqual(
    rangeSelectedIds(displayedQa(), 'A', 'C'),
    rangeSelectedIds(grouped, 'A', 'C'),
  );
});

test('full-lane range spans every visible card in order', () => {
  assert.deepEqual(rangeSelectedIds(displayedQa(), 'D', 'B'), [
    'D',
    'A',
    'C',
    'B',
  ]);
});

test('same anchor and target selects just that card', () => {
  assert.deepEqual(rangeSelectedIds(displayedQa(), 'C', 'C'), ['C']);
});

test('returns null when an endpoint is not in the lane', () => {
  assert.equal(rangeSelectedIds(displayedQa(), 'A', 'Z'), null);
  assert.equal(rangeSelectedIds(displayedQa(), 'Z', 'A'), null);
});
