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
import { handleTaskMerged } from '../routes/tasks/hooks/merged.js';
import { handleTaskMergeAborted } from '../routes/tasks/hooks/mergeAborted.js';

const ORIGIN = 'http://127.0.0.1:5184';

// Minimal Express req/res doubles. The hook handlers only ever touch
// req.params.id and res.status()/res.json(); capture what they emit.
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
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(body: unknown) {
      res.body = body;
      return res;
    },
  };
  return res;
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mockReq(id: string): any {
  return { params: { id }, query: {} };
}

// Regression for the "Cancel is authoritative" fix: once a conflict has been
// cancelled via /merge-aborted, a late /merged from the abandoned resolver
// (which kept running and curled the old callback) must NOT advance the task
// to qa or fast-forward main. The guard is `task.conflict` — /merge-aborted
// clears it, so /merged finds nothing to finalize and no-ops.
test('a cancelled conflict makes a late /merged a harmless no-op (task stays ready_to_merge, never finalized)', async () => {
  const stamp = `${Date.now()}_${process.pid}`;
  const base = await fs.mkdtemp(
    path.join(os.tmpdir(), `lattice-merge-aborted-${stamp}-`),
  );
  // Real (empty, non-git) dirs so the handlers' isMidMerge / git probes
  // resolve cleanly to "not mid-merge" instead of throwing on a missing cwd.
  const projectPath = path.join(base, 'repo');
  const worktreePath = path.join(base, 'wt');
  await fs.mkdir(projectPath, { recursive: true });
  await fs.mkdir(worktreePath, { recursive: true });

  const task = await createTask(projectPath, 'conflict cancel fixture');
  // Drop it into the conflicted-resolver state the merge pipeline produces.
  await updateTask(task.id, {
    status: 'ready_to_merge',
    conflict: true,
    conflictStartedAt: Date.now(),
    branch: `lattice/${task.id}`,
    worktreePath,
  });

  try {
    // 1) User clicks "Cancel" on the Resolving strip → /merge-aborted.
    const abortRes = mockRes();
    await handleTaskMergeAborted(ORIGIN)(
      mockReq(task.id),
      abortRes as unknown as Response,
    );
    assert.deepEqual(abortRes.body, { ok: true });

    const afterAbort = await getTask(task.id);
    assert.equal(
      afterAbort?.conflict,
      undefined,
      'cancel clears the conflict flag',
    );
    assert.equal(
      afterAbort?.status,
      'ready_to_merge',
      'cancel returns the task to plain ready_to_merge',
    );

    // 2) The abandoned resolver — still running, or a late retry — curls the
    // OLD /merged callback. Before the fix this slipped past the (status-only)
    // guard and ran finalizeResolvedTask, fast-forwarding main behind the
    // user's back. Now it is gated on task.conflict and no-ops.
    const mergedRes = mockRes();
    await handleTaskMerged(ORIGIN)(
      mockReq(task.id),
      mergedRes as unknown as Response,
    );
    assert.equal(
      mergedRes.statusCode,
      200,
      'late /merged is accepted as a no-op, not errored into a finalize attempt',
    );
    assert.deepEqual(
      mergedRes.body,
      { ok: true },
      'late /merged returns the bare idempotent ok — no finalized/conflict shape',
    );

    // 3) The task was never advanced — it stays ready_to_merge (main was
    // never fast-forwarded) so a human can re-merge on their own terms.
    const afterMerged = await getTask(task.id);
    assert.equal(
      afterMerged?.status,
      'ready_to_merge',
      'task stays ready_to_merge — the cancelled conflict was never finalized',
    );
    assert.equal(afterMerged?.conflict, undefined, 'still no conflict flag');
  } finally {
    await deleteTask(task.id);
    await flushPersist(projectPath).catch(() => {});
    await fs
      .rm(homeProjectDir(projectPath), { recursive: true, force: true })
      .catch(() => {});
    await fs.rm(base, { recursive: true, force: true }).catch(() => {});
  }
});
