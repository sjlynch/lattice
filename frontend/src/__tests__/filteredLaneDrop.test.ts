import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Task } from '../api';
import { sortTasksForLane } from '../components/taskboard/laneSort.ts';
import { groupTasksByStatus } from '../components/taskboard/hooks/useTaskBoardState.ts';
import { rangeSelectedIds } from '../components/taskboard/hooks/useTaskSelection.ts';
import {
  fullLaneDropIndex,
  multiDropOrder,
  singleDropOrder,
} from '../components/taskboard/reorderMath.ts';

function task(id: string, over: Partial<Task> = {}): Task {
  return {
    id,
    projectPath: 'C:/proj',
    title: id,
    status: 'open',
    createdAt: 0,
    ...over,
  };
}

// An Open lane shown newest-first ('recent'): E, D, C, B, A. A board search
// matches only D and A, so the lane renders [D, A] and its drop slots count
// just those two cards: slot 0 above D, slot 1 between D and A, slot 2 below A.
const A = task('A', { createdAt: 1, title: 'match A' });
const B = task('B', { createdAt: 2 });
const C = task('C', { createdAt: 3 });
const D = task('D', { createdAt: 4, title: 'match D' });
const E = task('E', { createdAt: 5 });
// A card from another lane being dragged into Open.
const X = task('X', { createdAt: 9, status: 'backlog' });
const Y = task('Y', { createdAt: 8, status: 'backlog' });

const ALL = [A, B, C, D, E];

function fullOpen(): Task[] {
  return sortTasksForLane(groupTasksByStatus(ALL).open, 'open', 'recent');
}
// Mirrors useTaskSearch → useTaskBoardDataView: group the FILTERED tasks, then
// display-sort — the exact array the Lane renders.
function visibleOpen(): Task[] {
  const filtered = ALL.filter((t) => t.title.includes('match'));
  return sortTasksForLane(groupTasksByStatus(filtered).open, 'open', 'recent');
}
const ids = (tasks: Task[]) => tasks.map((t) => t.id);

test('fixture: full lane E,D,C,B,A; search shows only D,A', () => {
  assert.deepEqual(ids(fullOpen()), ['E', 'D', 'C', 'B', 'A']);
  assert.deepEqual(ids(visibleOpen()), ['D', 'A']);
});

test('no search: the slot index is unchanged', () => {
  for (let i = 0; i <= 5; i++) {
    assert.equal(fullLaneDropIndex(fullOpen(), fullOpen(), i), i);
  }
});

test('slots map above the next visible card, or after the last one', () => {
  assert.equal(fullLaneDropIndex(fullOpen(), visibleOpen(), 0), 1); // above D
  assert.equal(fullLaneDropIndex(fullOpen(), visibleOpen(), 1), 4); // above A
  assert.equal(fullLaneDropIndex(fullOpen(), visibleOpen(), 2), 5); // after A
});

test('same-lane: dragging D below A lands D below A', () => {
  const full = fullOpen();
  const at = fullLaneDropIndex(full, visibleOpen(), 2, ['D']);
  const order = singleDropOrder(full, D, 'open', at);
  assert.deepEqual(order, ['E', 'C', 'B', 'A', 'D']);
  assert.ok(order!.indexOf('D') > order!.indexOf('A'));
});

test('same-lane: dragging A above D lands A above D', () => {
  const full = fullOpen();
  const at = fullLaneDropIndex(full, visibleOpen(), 0, ['A']);
  assert.deepEqual(singleDropOrder(full, A, 'open', at), ['E', 'A', 'D', 'C', 'B']);
});

test('same-lane: dropping a card onto its own visible slot is a no-op', () => {
  // D sits at visible index 0; slots 0 and 1 are both "where it already is".
  assert.equal(singleDropOrder(visibleOpen(), D, 'open', 0), null);
  assert.equal(singleDropOrder(visibleOpen(), D, 'open', 1), null);
});

test('regression: the unmapped index silently ignored the D-below-A drop', () => {
  // Filtered slot 2 spliced straight into [E,D,C,B,A] computes a no-op.
  assert.equal(singleDropOrder(fullOpen(), D, 'open', 2), null);
});

test('cross-lane: dropping between D and A lands between D and A', () => {
  const full = fullOpen();
  const at = fullLaneDropIndex(full, visibleOpen(), 1, ['X']);
  const order = singleDropOrder(full, X, 'open', at)!;
  assert.deepEqual(order, ['E', 'D', 'C', 'B', 'X', 'A']);
  assert.ok(order.indexOf('D') < order.indexOf('X'));
  assert.ok(order.indexOf('X') < order.indexOf('A'));
});

test('regression: the unmapped cross-lane index landed ABOVE D', () => {
  assert.deepEqual(singleDropOrder(fullOpen(), X, 'open', 1), [
    'E',
    'X',
    'D',
    'C',
    'B',
    'A',
  ]);
});

test('cross-lane: dropping at the top / bottom slot brackets the visible cards', () => {
  const full = fullOpen();
  const top = singleDropOrder(full, X, 'open', fullLaneDropIndex(full, visibleOpen(), 0))!;
  assert.deepEqual(top, ['E', 'X', 'D', 'C', 'B', 'A']);
  const bottom = singleDropOrder(full, X, 'open', fullLaneDropIndex(full, visibleOpen(), 2))!;
  assert.deepEqual(bottom, ['E', 'D', 'C', 'B', 'A', 'X']);
});

test('multi cross-lane: the block lands between D and A', () => {
  const full = fullOpen();
  const moving = ['X', 'Y'];
  const at = fullLaneDropIndex(full, visibleOpen(), 1, moving);
  assert.deepEqual(multiDropOrder(full, [X, Y], moving, at), [
    'E',
    'D',
    'C',
    'B',
    'X',
    'Y',
    'A',
  ]);
});

test('a moving card is never used as the anchor', () => {
  // Dragging [A] (plus another card) to slot 1: the only visible card at/after
  // the slot is A itself, so the drop falls back to "after the last visible".
  assert.equal(fullLaneDropIndex(fullOpen(), visibleOpen(), 1, ['A']), 5);
});

test('a lane the search empties entirely appends to the full lane', () => {
  assert.equal(fullLaneDropIndex(fullOpen(), [], 0), 5);
});

test('shift-range over the filtered lane selects only visible cards', () => {
  assert.deepEqual(rangeSelectedIds(visibleOpen(), 'D', 'A'), ['D', 'A']);
  assert.deepEqual(rangeSelectedIds(visibleOpen(), 'A', 'D'), ['D', 'A']);
  // The pre-fix path sliced the unfiltered lane and swept in hidden C and B.
  assert.deepEqual(rangeSelectedIds(fullOpen(), 'D', 'A'), ['D', 'C', 'B', 'A']);
});
