import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resumeQueuedTaskRuns,
  type ResumeQueuedTaskRunsDeps,
} from '../recovery/queuedRunResume.js';
import type { Task } from '../tasks.js';

// Boot-recovery coverage for two guarantees the queued-run rework adds:
//   1. A queued run re-enqueues with its ORIGINAL harness/Pi model after a
//      restart, instead of silently falling back to the default.
//   2. A run that has been attempted past the retry ceiling is NOT re-enqueued
//      and has its queued state cleared (so the card drops the permanent
//      "Queued" pill and a manual re-run starts fresh).

const ORIGIN = 'http://127.0.0.1:5184';

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 't1',
    projectPath: 'C:\\development\\proj',
    title: 'My task',
    status: 'open',
    createdAt: 0,
    runQueued: true,
    runQueuedAt: 1,
    ...overrides,
  };
}

function makeDeps(tasks: Task[]): {
  deps: ResumeQueuedTaskRunsDeps;
  enqueued: Array<{
    taskId: string;
    origin: string;
    harness: unknown;
    piModel: unknown;
  }>;
  updated: Array<{ id: string; updates: Partial<Task> }>;
} {
  const enqueued: Array<{
    taskId: string;
    origin: string;
    harness: unknown;
    piModel: unknown;
  }> = [];
  const updated: Array<{ id: string; updates: Partial<Task> }> = [];
  const deps: ResumeQueuedTaskRunsDeps = {
    forEachKnownProjectSafely: async (_label, handle) => {
      await handle('C:\\development\\proj');
    },
    listTasks: async () => tasks,
    enqueueTaskRun: async (taskId, origin, harness, piModel) => {
      enqueued.push({ taskId, origin, harness, piModel });
      return { queued: false };
    },
    updateTask: async (id, updates) => {
      updated.push({ id, updates: updates as Partial<Task> });
      return null;
    },
  };
  return { deps, enqueued, updated };
}

test('resumeQueuedTaskRuns: a queued Pi-model run re-enqueues with its original harness/model after a restart', async () => {
  const { deps, enqueued, updated } = makeDeps([
    makeTask({
      runQueuedHarness: 'pi',
      runQueuedPiModel: 'qwen-local/qwen',
    }),
  ]);

  await resumeQueuedTaskRuns(ORIGIN, deps);

  assert.equal(enqueued.length, 1);
  assert.equal(enqueued[0].taskId, 't1');
  assert.equal(enqueued[0].origin, ORIGIN);
  assert.equal(enqueued[0].harness, 'pi');
  assert.equal(enqueued[0].piModel, 'qwen-local/qwen');
  // Not given up — no clearing write.
  assert.equal(updated.length, 0);
});

test('resumeQueuedTaskRuns: a run with no explicit harness re-enqueues with undefined (defer to the default)', async () => {
  const { deps, enqueued } = makeDeps([makeTask({ runFailureCount: 1 })]);

  await resumeQueuedTaskRuns(ORIGIN, deps);

  assert.equal(enqueued.length, 1);
  assert.equal(enqueued[0].harness, undefined);
  assert.equal(enqueued[0].piModel, undefined);
});

test('resumeQueuedTaskRuns: at the retry ceiling it stops re-enqueuing and clears all queued state', async () => {
  const { deps, enqueued, updated } = makeDeps([
    makeTask({
      runFailureCount: 3, // == MAX_QUEUED_RUN_RETRIES
      runQueuedHarness: 'pi',
      runQueuedPiModel: 'qwen-local/qwen',
    }),
  ]);

  await resumeQueuedTaskRuns(ORIGIN, deps);

  // Exhausted: not re-enqueued.
  assert.equal(enqueued.length, 0);
  // Queued state cleared so the pill disappears and a manual re-run starts fresh.
  assert.equal(updated.length, 1);
  assert.equal(updated[0].id, 't1');
  assert.equal(updated[0].updates.runQueued, undefined);
  assert.equal(updated[0].updates.runQueuedAt, undefined);
  assert.equal(updated[0].updates.runQueuedHarness, undefined);
  assert.equal(updated[0].updates.runQueuedPiModel, undefined);
  assert.equal(updated[0].updates.runFailureCount, undefined);
});

test('resumeQueuedTaskRuns: a run just under the ceiling is still re-enqueued', async () => {
  const { deps, enqueued, updated } = makeDeps([
    makeTask({ runFailureCount: 2 }),
  ]);

  await resumeQueuedTaskRuns(ORIGIN, deps);

  assert.equal(enqueued.length, 1);
  assert.equal(updated.length, 0);
});

test('resumeQueuedTaskRuns: skips tasks that are not queued or not freshly runnable', async () => {
  const { deps, enqueued, updated } = makeDeps([
    // Not queued.
    makeTask({ id: 'a', runQueued: undefined }),
    // Queued but already running with a worktree (not freshly runnable).
    makeTask({
      id: 'b',
      status: 'in_progress',
      worktreePath: 'C:\\wt\\b',
    }),
    // Queued and freshly runnable (in_progress, no worktree).
    makeTask({ id: 'c', status: 'in_progress' }),
  ]);

  await resumeQueuedTaskRuns(ORIGIN, deps);

  assert.equal(enqueued.length, 1);
  assert.equal(enqueued[0].taskId, 'c');
  assert.equal(updated.length, 0);
});
