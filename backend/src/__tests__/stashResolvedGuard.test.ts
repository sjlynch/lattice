import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
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

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

// A project repo on `main` plus a lattice/* branch checked out in a worktree
// with one commit that is NOT on main.
async function repoWithUnmergedBranch(prefix: string) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), `${prefix}-${process.pid}-`));
  const projectPath = path.join(base, 'repo');
  const worktreePath = path.join(base, 'wt');
  const branch = `lattice/stash-${Date.now()}-${process.pid}`;
  await fs.mkdir(projectPath, { recursive: true });
  git(projectPath, ['init', '-q', '-b', 'main']);
  git(projectPath, ['config', 'user.email', 't@t']);
  git(projectPath, ['config', 'user.name', 'lattice-test']);
  await fs.writeFile(path.join(projectPath, 'a.txt'), 'a\n', 'utf8');
  git(projectPath, ['add', '-A']);
  git(projectPath, ['commit', '-q', '-m', 'init']);
  git(projectPath, ['worktree', 'add', '-q', worktreePath, '-b', branch]);
  await fs.writeFile(path.join(worktreePath, 'a.txt'), 'b\n', 'utf8');
  git(worktreePath, ['commit', '-q', '-am', 'unmerged work']);
  return { base, projectPath, worktreePath, branch };
}

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

// Regression: the only guard was the ready_to_merge status check, so a stray
// or late curl against a Ready-to-Merge task whose branch was never merged ran
// cleanup WITHOUT keepBranchIfUnmerged (`git branch -D` of the unmerged work)
// and flipped it to qa with a fresh mergedAt — which qaRuns/verdict.ts treats
// as a real merge. It must be a no-op unless the branch is already in HEAD.
test('/stash-resolved on a ready_to_merge task with an unmerged branch is a no-op', async () => {
  const { base, projectPath, worktreePath, branch } = await repoWithUnmergedBranch('lattice-stash-unmerged');
  const task = await createTask(projectPath, 'stash unmerged fixture');
  await updateTask(task.id, { status: 'ready_to_merge', branch, worktreePath });

  const cleanupCalls: unknown[][] = [];
  let runStarts = 0;
  try {
    const res = mockRes();
    await handleTaskStashResolved(ORIGIN, {
      cleanupWorktree: async (...args: unknown[]) => {
        cleanupCalls.push(args);
        return true;
      },
      startMergeRun: async () => { runStarts++; return { total: 1 }; },
    })(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { params: { id: task.id }, query: {} } as any,
      res as unknown as Response,
    );
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, { ok: true });
    assert.equal(cleanupCalls.length, 0, 'an unmerged branch must not be cleaned up');
    assert.equal(runStarts, 0, 'no merge run restart for a no-op');

    const after = await getTask(task.id);
    assert.equal(after?.status, 'ready_to_merge');
    assert.equal(after?.mergedAt, undefined);
    assert.equal(after?.branch, branch);
    assert.equal(after?.worktreePath, worktreePath);
    assert.ok(git(projectPath, ['branch', '--list', branch]).includes(branch), 'branch still exists');
  } finally {
    await deleteTask(task.id).catch(() => {});
    await flushPersist(projectPath).catch(() => {});
    await fs.rm(homeProjectDir(projectPath), { recursive: true, force: true }).catch(() => {});
    try { git(projectPath, ['worktree', 'remove', '--force', worktreePath]); } catch { /* ignore */ }
    await fs.rm(base, { recursive: true, force: true }).catch(() => {});
  }
});

// Happy path: finalize.ts fast-forwarded main to the branch before spawning the
// stash resolver, so the branch is an ancestor of HEAD — cleanup runs (with
// keepBranchIfUnmerged as a backstop) and the task moves to qa.
test('/stash-resolved on a ready_to_merge task whose branch is merged cleans up and moves to qa', async () => {
  const { base, projectPath, worktreePath, branch } = await repoWithUnmergedBranch('lattice-stash-merged');
  git(projectPath, ['merge', '-q', '--ff-only', branch]);
  const task = await createTask(projectPath, 'stash merged fixture');
  await updateTask(task.id, { status: 'ready_to_merge', branch, worktreePath });

  const cleanupCalls: unknown[][] = [];
  try {
    const res = mockRes();
    await handleTaskStashResolved(ORIGIN, {
      cleanupWorktree: async (...args: unknown[]) => {
        cleanupCalls.push(args);
        return true;
      },
      // A run "picked up" remaining work, so the handler doesn't fire the
      // post-merge hook itself.
      startMergeRun: async () => ({ total: 1 }),
    })(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { params: { id: task.id }, query: {} } as any,
      res as unknown as Response,
    );
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, { ok: true });
    assert.equal(cleanupCalls.length, 1);
    assert.deepEqual(cleanupCalls[0].slice(0, 3), [projectPath, worktreePath, branch]);
    assert.deepEqual(cleanupCalls[0][4], { keepBranchIfUnmerged: true });

    const after = await getTask(task.id);
    assert.equal(after?.status, 'qa');
    assert.equal(typeof after?.mergedAt, 'number');
    assert.equal(after?.branch, undefined);
    assert.equal(after?.worktreePath, undefined);
  } finally {
    await deleteTask(task.id).catch(() => {});
    await flushPersist(projectPath).catch(() => {});
    await fs.rm(homeProjectDir(projectPath), { recursive: true, force: true }).catch(() => {});
    try { git(projectPath, ['worktree', 'remove', '--force', worktreePath]); } catch { /* ignore */ }
    await fs.rm(base, { recursive: true, force: true }).catch(() => {});
  }
});
