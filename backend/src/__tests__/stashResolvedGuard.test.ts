import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import type { Response } from 'express';
import {
  createTask,
  getTask,
  updateTask,
  deleteTask,
  flushPersist,
} from '../tasks.js';
import { homeProjectDir } from '../projectPath.js';
import { handleTaskStashResolved } from '../routes/tasks/hooks/stashResolved.js';

const ORIGIN = 'http://127.0.0.1:5184';

type MockRes = {
  statusCode: number;
  body: unknown;
  status: (code: number) => MockRes;
  json: (body: unknown) => MockRes;
};
function mockRes(): MockRes {
  const res: MockRes = {
    statusCode: 200,
    body: undefined,
    status(code: number) { res.statusCode = code; return res; },
    json(body: unknown) { res.body = body; return res; },
  };
  return res;
}

// /stash-resolved had no status guard. Its only legitimate caller
// (worktree/finalize.ts) spawns the stash resolver for a ready_to_merge task,
// but a stray or late curl against an in_progress task ran
// cleanupWorktreeForTask — killing the agent's ptys and removing its worktree —
// and flipped it to qa. Any other lane must be an idempotent no-op (as /merged).
test('/stash-resolved on an in_progress task is a no-op: 200, status unchanged, cleanup never called', async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), `lattice-stash-guard-${process.pid}-`));
  const projectPath = path.join(base, 'repo');
  const worktreePath = path.join(base, 'wt');
  await fs.mkdir(projectPath, { recursive: true });
  await fs.mkdir(worktreePath, { recursive: true });

  const task = await createTask(projectPath, 'stash guard fixture');
  await updateTask(task.id, {
    status: 'in_progress',
    branch: `lattice/${task.id}`,
    worktreePath,
    startedAt: Date.now(),
  });

  const cleanupCalls: unknown[][] = [];
  try {
    const res = mockRes();
    await handleTaskStashResolved(ORIGIN, {
      cleanupWorktree: async (...args: unknown[]) => {
        cleanupCalls.push(args);
        return true;
      },
    })(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { params: { id: task.id }, query: {} } as any,
      res as unknown as Response,
    );
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, { ok: true });
    assert.equal(cleanupCalls.length, 0, 'the in_progress worktree must not be torn down');

    const after = await getTask(task.id);
    assert.equal(after?.status, 'in_progress');
    assert.equal(after?.worktreePath, worktreePath);
    assert.equal(after?.branch, `lattice/${task.id}`);
    assert.equal(after?.mergedAt, undefined);
  } finally {
    await deleteTask(task.id);
    await flushPersist(projectPath).catch(() => {});
    await fs.rm(homeProjectDir(projectPath), { recursive: true, force: true }).catch(() => {});
    await fs.rm(base, { recursive: true, force: true }).catch(() => {});
  }
});

test('/stash-resolved still 404s an unknown task', async () => {
  const res = mockRes();
  await handleTaskStashResolved(ORIGIN, {
    cleanupWorktree: async () => { throw new Error('must not be called'); },
  })(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    { params: { id: 'no-such-task' }, query: {} } as any,
    res as unknown as Response,
  );
  assert.equal(res.statusCode, 404);
});

// The `?project=` pin: /stash-resolved removes the worktree and re-lanes the
// task, and /merged fast-forwards main, so a call naming another board must be
// a 404 that touches nothing (as /merge-aborted already was).
test('/stash-resolved and /merged 404 a task from another project and touch nothing', async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), `lattice-stash-pin-${process.pid}-`));
  const projectPath = path.join(base, 'repo');
  const otherProject = path.join(base, 'other');
  const worktreePath = path.join(base, 'wt');
  await fs.mkdir(projectPath, { recursive: true });
  await fs.mkdir(otherProject, { recursive: true });
  await fs.mkdir(worktreePath, { recursive: true });

  const task = await createTask(projectPath, 'stash pin fixture');
  await updateTask(task.id, {
    status: 'ready_to_merge',
    branch: `lattice/${task.id}`,
    worktreePath,
    conflict: true,
  });

  const cleanupCalls: unknown[][] = [];
  try {
    const res = mockRes();
    await handleTaskStashResolved(ORIGIN, {
      cleanupWorktree: async (...args: unknown[]) => {
        cleanupCalls.push(args);
        return true;
      },
    })(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { params: { id: task.id }, query: { project: otherProject } } as any,
      res as unknown as Response,
    );
    assert.equal(res.statusCode, 404);
    assert.equal(cleanupCalls.length, 0);

    const { handleTaskMerged } = await import('../routes/tasks/hooks/merged.js');
    const mergedRes = mockRes();
    await handleTaskMerged(ORIGIN)(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { params: { id: task.id }, query: { project: otherProject } } as any,
      mergedRes as unknown as Response,
    );
    assert.equal(mergedRes.statusCode, 404);

    const after = await getTask(task.id);
    assert.equal(after?.status, 'ready_to_merge');
    assert.equal(after?.worktreePath, worktreePath);
    assert.equal(after?.conflict, true);
  } finally {
    await deleteTask(task.id);
    await flushPersist(projectPath).catch(() => {});
    await fs.rm(homeProjectDir(projectPath), { recursive: true, force: true }).catch(() => {});
    await fs.rm(base, { recursive: true, force: true }).catch(() => {});
  }
});
