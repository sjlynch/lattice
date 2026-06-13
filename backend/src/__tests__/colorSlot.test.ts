import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assignColorSlot } from '../routes/tasks/colorSlot.js';
import type { Task } from '../tasks.js';

// assignColorSlot hands each newly-spawned task the smallest palette slot
// not currently claimed by another *active* (in_progress / ready_to_merge)
// task — so a fleet of agents maps onto a compact, maximally-distinct range
// and a finished task's slot is reused, never reshuffling live tasks.

function task(p: Partial<Task>): Task {
  return {
    id: p.id ?? 'x',
    projectPath: '/p',
    title: 'T',
    status: p.status ?? 'in_progress',
    createdAt: 0,
    ...p,
  };
}

test('assignColorSlot: first active task gets slot 0', () => {
  assert.equal(assignColorSlot([], 'a'), 0);
  assert.equal(
    assignColorSlot([task({ id: 'a', status: 'open' })], 'a'),
    0,
  );
});

test('assignColorSlot: fills the lowest gap among active tasks', () => {
  const tasks = [
    task({ id: 'a', colorIndex: 0 }),
    task({ id: 'b', colorIndex: 2, status: 'ready_to_merge' }),
  ];
  // 1 is the lowest free slot (0 and 2 are taken).
  assert.equal(assignColorSlot(tasks, 'c'), 1);
});

test('assignColorSlot: ignores self, and non-active / unslotted tasks', () => {
  const tasks = [
    task({ id: 'self', colorIndex: 0 }), // excluded as self
    task({ id: 'done', colorIndex: 1, status: 'done' }), // not active
    task({ id: 'qa', colorIndex: 3, status: 'qa' }), // not active
    task({ id: 'open', status: 'open' }), // no slot, not active
  ];
  // Only `self`'s slot would count, but it's excluded — so 0 is free.
  assert.equal(assignColorSlot(tasks, 'self'), 0);
});

test('assignColorSlot: reuses a freed slot once a sibling leaves', () => {
  // a(0) finished (qa) → its slot is free; b(1) still active.
  const tasks = [
    task({ id: 'a', colorIndex: 0, status: 'qa' }),
    task({ id: 'b', colorIndex: 1, status: 'in_progress' }),
  ];
  assert.equal(assignColorSlot(tasks, 'c'), 0);
});
