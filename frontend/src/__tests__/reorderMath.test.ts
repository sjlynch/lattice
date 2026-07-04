import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Task, TaskStatus } from '../api';
import { arrivalTime, sortTasksForLane } from '../components/taskboard/laneSort.ts';
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

// ---------------------------------------------------------------------------
// arrivalTime: the per-status arrival stamp + its updatedAt→createdAt fallback
// chain. Only the in_progress branch (startedAt) is exercised above; a wrong
// stamp mapping would silently sort a lane by the wrong time.
// ---------------------------------------------------------------------------

// A task carrying a DISTINCT value for every stamp, so each branch's pick is
// unambiguous: createdAt < updatedAt < startedAt < completedAt < mergedAt < doneAt.
const stamped = task('stamped', {
  createdAt: 1,
  updatedAt: 2,
  startedAt: 3,
  completedAt: 4,
  mergedAt: 5,
  doneAt: 6,
});

test('arrivalTime picks the lane-specific stamp for each status', () => {
  assert.equal(arrivalTime(stamped, 'in_progress'), 3); // startedAt
  assert.equal(arrivalTime(stamped, 'ready_to_merge'), 4); // completedAt
  assert.equal(arrivalTime(stamped, 'qa'), 5); // mergedAt
  assert.equal(arrivalTime(stamped, 'done'), 6); // doneAt
  assert.equal(arrivalTime(stamped, 'deleted'), 2); // updatedAt (when binned)
  assert.equal(arrivalTime(stamped, 'open'), 1); // createdAt
  assert.equal(arrivalTime(stamped, 'backlog'), 1); // createdAt
  // An unrecognised status hits the switch default → createdAt.
  assert.equal(arrivalTime(stamped, 'weird' as TaskStatus), 1);
});

test('arrivalTime falls back updatedAt→createdAt when the primary stamp is missing', () => {
  // ready_to_merge with no completedAt uses updatedAt; with neither, createdAt.
  assert.equal(
    arrivalTime(task('r1', { createdAt: 1, updatedAt: 2 }), 'ready_to_merge'),
    2,
  );
  assert.equal(arrivalTime(task('r2', { createdAt: 1 }), 'ready_to_merge'), 1);
  // in_progress (startedAt), qa (mergedAt) and done (doneAt) fall back alike.
  assert.equal(
    arrivalTime(task('i1', { createdAt: 1, updatedAt: 2 }), 'in_progress'),
    2,
  );
  assert.equal(arrivalTime(task('i2', { createdAt: 1 }), 'in_progress'), 1);
  assert.equal(arrivalTime(task('q1', { createdAt: 1, updatedAt: 2 }), 'qa'), 2);
  assert.equal(arrivalTime(task('q2', { createdAt: 1 }), 'qa'), 1);
  assert.equal(
    arrivalTime(task('d1', { createdAt: 1, updatedAt: 2 }), 'done'),
    2,
  );
  assert.equal(arrivalTime(task('d2', { createdAt: 1 }), 'done'), 1);
  // deleted's PRIMARY stamp is already updatedAt, so with no updatedAt it lands
  // straight on createdAt.
  assert.equal(arrivalTime(task('x1', { createdAt: 1 }), 'deleted'), 1);
});

// ---------------------------------------------------------------------------
// sortTasksForLane: tiebreaker chain + direction symmetry + manual passthrough.
// ---------------------------------------------------------------------------

test("'manual' mode returns the input order unchanged", () => {
  // Grouped order [C, B, A] is deliberately NOT arrival order; manual must not
  // reorder it (hand-drag order wins until the clock is clicked).
  const out = sortTasksForLane([C, B, A], 'in_progress', 'manual');
  assert.deepEqual(out.map((t) => t.id), ['C', 'B', 'A']);
});

test('equal arrivalTime falls back to createdAt, and createdAt follows the sort direction', () => {
  // Same startedAt (arrival tie), different createdAt → createdAt breaks the tie
  // in the SAME direction as the arrival key would have.
  const P = task('P', { createdAt: 10, startedAt: 500 });
  const Q = task('Q', { createdAt: 20, startedAt: 500 });
  // recent (newest first): higher createdAt wins → Q before P.
  assert.deepEqual(
    sortTasksForLane([P, Q], 'in_progress', 'recent').map((t) => t.id),
    ['Q', 'P'],
  );
  // oldest (oldest first): lower createdAt wins → P before Q.
  assert.deepEqual(
    sortTasksForLane([P, Q], 'in_progress', 'oldest').map((t) => t.id),
    ['P', 'Q'],
  );
});

test('recent and oldest apply one direction to both the arrival key and the createdAt tiebreaker', () => {
  // Two tasks tie on arrival (startedAt 900) but differ on createdAt, plus an
  // earlier arrival. oldest must be the exact mirror of recent across BOTH keys.
  const early = task('E', { createdAt: 1, startedAt: 100 });
  const lateHi = task('H', { createdAt: 30, startedAt: 900 });
  const lateLo = task('L', { createdAt: 20, startedAt: 900 });
  // recent: arrival desc, then createdAt desc within the 900 tie.
  assert.deepEqual(
    sortTasksForLane([early, lateLo, lateHi], 'in_progress', 'recent').map(
      (t) => t.id,
    ),
    ['H', 'L', 'E'],
  );
  // oldest: arrival asc, then createdAt asc — the reverse of recent.
  assert.deepEqual(
    sortTasksForLane([early, lateLo, lateHi], 'in_progress', 'oldest').map(
      (t) => t.id,
    ),
    ['E', 'L', 'H'],
  );
});

test('a total arrival+createdAt tie falls back to a stable ascending id compare', () => {
  // When both stamps tie, id is the final deterministic tiebreaker. It is a
  // plain ascending string compare that does NOT flip with direction, so both
  // modes agree — keeping equal-time cards from reshuffling between sorts.
  const a1 = task('a1', { createdAt: 5, startedAt: 500 });
  const b1 = task('b1', { createdAt: 5, startedAt: 500 });
  assert.deepEqual(
    sortTasksForLane([b1, a1], 'in_progress', 'recent').map((t) => t.id),
    ['a1', 'b1'],
  );
  assert.deepEqual(
    sortTasksForLane([b1, a1], 'in_progress', 'oldest').map((t) => t.id),
    ['a1', 'b1'],
  );
});
