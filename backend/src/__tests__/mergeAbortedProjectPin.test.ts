import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import type { Response } from 'express';
import { createTask, deleteTask, flushPersist, type Task } from '../tasks.js';
import { homeProjectDir } from '../projectPath.js';
import { handleTaskMergeAborted } from '../routes/tasks/hooks/mergeAborted.js';

// POST /api/tasks/:id/merge-aborted honours the `?project=` pin like every
// other by-id task route: a task from another board is a 404 and nothing is
// aborted. A missing/empty project stays unpinned so a resolver agent's
// give-up curl (which never sends one) keeps working.

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

test('/merge-aborted 404s a task from another project and leaves it untouched; unpinned calls still work', async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'lattice-merge-aborted-pin-'));
  const projectPath = path.join(base, 'repo');
  const otherProject = path.join(base, 'other');
  await fs.mkdir(projectPath, { recursive: true });
  await fs.mkdir(otherProject, { recursive: true });
  const task = await createTask(projectPath, 'pin fixture');

  const recovered: string[] = [];
  const handler = handleTaskMergeAborted('http://127.0.0.1:5184', {
    recover: async (t: Task) => { recovered.push(t.id); },
    signalConflictWaiter: () => false,
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const call = async (query: Record<string, string>): Promise<MockRes> => {
    const res = mockRes();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handler({ params: { id: task.id }, query } as any, res as unknown as Response);
    return res;
  };

  try {
    const foreign = await call({ project: otherProject });
    assert.equal(foreign.statusCode, 404);
    assert.deepEqual(recovered, [], 'nothing aborted for a foreign-board call');

    const own = await call({ project: projectPath });
    assert.equal(own.statusCode, 200);
    assert.deepEqual(own.body, { ok: true });

    const unpinned = await call({});
    assert.equal(unpinned.statusCode, 200);
    const empty = await call({ project: '' });
    assert.equal(empty.statusCode, 200);
    assert.deepEqual(recovered, [task.id, task.id, task.id]);
  } finally {
    await deleteTask(task.id);
    await flushPersist(projectPath).catch(() => {});
    await fs.rm(homeProjectDir(projectPath), { recursive: true, force: true }).catch(() => {});
    await fs.rm(base, { recursive: true, force: true }).catch(() => {});
  }
});
