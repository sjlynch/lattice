import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Request, Response } from 'express';
import { createTask, getTask, updateTaskCrashSafe } from '../tasks.js';
import { projectTasksFile } from '../taskCache/paths.js';
import { handleTaskComplete } from '../routes/tasks/hooks/complete.js';

// Regression: the in_progress → ready_to_merge flip in POST /api/tasks/:id/complete
// used the DEBOUNCED updateTask (100 ms ProjectStateManager.schedulePersist), so a
// backend hot-restart inside that window (routine in dev — tsc -w + scripts/dev.mjs
// restart the backend on any backend/src change) would lose the flip on disk: the
// next boot reads in_progress, the pty is already gone, and the Stop hook (which
// fires exactly once) never re-fires — stranding a finished task at in_progress.
// The fix switches the flip to updateTaskCrashSafe (disk-before-cache), matching
// the sibling one-way finalizers (merged.ts / stashResolved.ts, ready_to_merge → qa).
//
// This test drives the real handler and asserts the new status is on DISK the
// instant the handler resolves — i.e. before the debounce would ever fire. With
// the old debounced write, the on-disk read would still show in_progress and this
// test would fail.

// Read the status of a single task straight off ~/.lattice, never the in-memory
// cache — the whole point is to prove the write reached disk synchronously.
async function diskStatus(projectPath: string, taskId: string): Promise<string | undefined> {
  const raw = await fs.readFile(projectTasksFile(projectPath), 'utf8');
  const tasks = JSON.parse(raw) as Array<{ id: string; status: string }>;
  return tasks.find((t) => t.id === taskId)?.status;
}

// Minimal Express req/res doubles: the no-branch flip path only touches
// req.params.id / req.query.source and res.status().json().
function fakeReqRes(taskId: string): {
  req: Request<{ id: string }>;
  res: Response;
  body: () => unknown;
} {
  let captured: unknown;
  const res = {
    status(_code: number) {
      return res;
    },
    json(payload: unknown) {
      captured = payload;
      return res;
    },
  } as unknown as Response;
  const req = {
    params: { id: taskId },
    query: { source: 'test' },
  } as unknown as Request<{ id: string }>;
  return { req, res, body: () => captured };
}

test('handleTaskComplete flips in_progress → ready_to_merge on disk without waiting for the debounce', async () => {
  const projectPath = path.join(os.tmpdir(), 'lattice-complete-crashsafe-project');

  const task = await createTask(projectPath, 'strand-me');
  // Baseline: a running task, persisted to disk crash-safely (no branch/worktree
  // so the handler skips the commit-count probe and the pty-kill setTimeout).
  await updateTaskCrashSafe(task.id, { status: 'in_progress' });
  assert.equal(await diskStatus(projectPath, task.id), 'in_progress', 'baseline on disk');

  const { req, res, body } = fakeReqRes(task.id);
  await handleTaskComplete('http://127.0.0.1:5184')(req, res);

  assert.deepEqual(body(), { ok: true });
  // The flip must be on disk the moment the handler resolves — NOT 100 ms later.
  assert.equal(
    await diskStatus(projectPath, task.id),
    'ready_to_merge',
    'the flip must survive a hot-restart: it has to be on disk before the debounce fires',
  );
  // In-memory cache agrees, and completedAt was stamped.
  const cached = await getTask(task.id);
  assert.equal(cached?.status, 'ready_to_merge');
  assert.ok(cached?.completedAt, 'completedAt stamped on the flip');
});
