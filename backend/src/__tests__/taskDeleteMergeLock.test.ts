import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import type { Response } from 'express';
import { createTask, deleteTask, flushPersist, getTask, updateTask } from '../tasks.js';
import { homeProjectDir } from '../projectPath.js';
import { isLocked, release, tryAcquire } from '../mergeLocks.js';
import { createTaskDeleteHandler } from '../routes/tasks/crudDelete.js';

// DELETE /api/tasks/:id takes the per-task merge lock. A merge run / manual
// /merge / resolver finalize holds it while running git inside the task's
// worktree and fast-forwarding main; a delete landing then used to remove the
// worktree under a live `git merge` and erase the record mid-finalize (the
// deleted work still landed on main, plus a "qa state could not be saved" run
// error). Now a held lock is waited out briefly, then answered 409 with no
// side effect; once released, the delete proceeds.

type MockRes = { statusCode: number; body: unknown; status: (c: number) => MockRes; json: (b: unknown) => MockRes };
function mockRes(): MockRes {
  const res: MockRes = {
    statusCode: 200,
    body: undefined,
    status(c) { res.statusCode = c; return res; },
    json(b) { res.body = b; return res; },
  };
  return res;
}

test('DELETE /api/tasks/:id 409s while the task merge lock is held, then deletes once released', async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'lattice-delete-merge-lock-'));
  const projectPath = path.join(base, 'repo');
  await fs.mkdir(projectPath, { recursive: true });
  const task = await createTask(projectPath, 'delete-lock fixture');
  await updateTask(task.id, {
    worktreePath: path.join(base, 'wt'),
    branch: 'lattice/delete-lock-fixture',
  });

  const cleanups: string[] = [];
  const handler = createTaskDeleteHandler({
    cleanupWorktree: async (_repo, worktreePath) => { cleanups.push(worktreePath); return true; },
    lockWaitMs: 50,
  });
  const call = async (): Promise<MockRes> => {
    const res = mockRes();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handler({ params: { id: task.id }, query: { project: projectPath } } as any, res as unknown as Response);
    return res;
  };

  const mergeLock = tryAcquire(task.id);
  assert.ok(mergeLock, 'fixture acquires the merge lock');
  try {
    const refused = await call();
    assert.equal(refused.statusCode, 409);
    assert.match(String((refused.body as { error?: unknown }).error), /being merged/);
    assert.deepEqual(cleanups, [], 'worktree teardown never runs under a held merge lock');
    assert.ok(await getTask(task.id), 'the task record survives the refused delete');
    assert.ok(isLocked(task.id), "the refused delete did not steal or drop the merge's lock");

    release(mergeLock);
    const done = await call();
    assert.equal(done.statusCode, 200);
    assert.deepEqual(done.body, { ok: true });
    assert.deepEqual(cleanups, [path.join(base, 'wt')]);
    assert.equal(await getTask(task.id), null);
    assert.equal(isLocked(task.id), false, 'the delete releases the lock it took');
  } finally {
    release(mergeLock);
    await deleteTask(task.id).catch(() => {});
    await flushPersist(projectPath).catch(() => {});
    await fs.rm(homeProjectDir(projectPath), { recursive: true, force: true }).catch(() => {});
    await fs.rm(base, { recursive: true, force: true }).catch(() => {});
  }
});
