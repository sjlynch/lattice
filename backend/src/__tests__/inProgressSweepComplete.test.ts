import { test } from 'node:test';
import assert from 'node:assert/strict';
import { autoCompleteStuckTask, type AutoCompleteDeps } from '../recovery/inProgressSweep/complete.js';
import type { Task } from '../tasks.js';

// Regression: the sweep flipped a task to ready_to_merge from the snapshot it
// took at the START of the pass (before an awaited git probe), so a Resume, a
// lane move or a real /complete landing meanwhile was overwritten — handing a
// still-working agent's branch to merge-all. It now re-reads the task first.

const snapshot: Task = {
  id: 't1', projectPath: '/p', title: 'stuck', status: 'in_progress', createdAt: 1,
  updatedAt: 100, worktreePath: '/wt', branch: 'lattice/t1',
};

function deps(fresh: Task | null) {
  const updates: unknown[] = [];
  const d: AutoCompleteDeps = {
    getTask: async () => fresh,
    updateTaskCrashSafe: async (_id, u) => { updates.push(u); return { ...snapshot, ...u } as Task; },
    readPiShutdownSentinel: async () => null,
  };
  return { d, updates };
}

test('auto-complete flips an unchanged stuck task (crash-safe)', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const { d, updates } = deps({ ...snapshot });
  assert.deepEqual(await autoCompleteStuckTask(snapshot, 2, 999_999, d), { ok: true });
  assert.equal((updates[0] as { status: string }).status, 'ready_to_merge');
});

for (const [name, fresh] of [
  ['resumed (updatedAt bumped)', { ...snapshot, updatedAt: 200 }],
  ['moved out of in_progress', { ...snapshot, status: 'open' as const }],
  ['re-run on another branch', { ...snapshot, branch: 'lattice/t1-r1' }],
  ['deleted', null],
] as const) {
  test(`auto-complete leaves a task that was ${name} during the pass`, async () => {
    const { d, updates } = deps(fresh as Task | null);
    assert.deepEqual(await autoCompleteStuckTask(snapshot, 2, 999_999, d), { ok: false, stale: true });
    assert.equal(updates.length, 0);
  });
}

test('auto-complete reports a failed crash-safe write as an error', async (t) => {
  t.mock.method(console, 'warn', () => {});
  t.mock.method(console, 'error', () => {});
  const { d } = deps({ ...snapshot });
  d.updateTaskCrashSafe = async () => null;
  const outcome = await autoCompleteStuckTask(snapshot, 2, 999_999, d);
  assert.equal(outcome.ok, false);
  assert.ok('error' in outcome);
});
