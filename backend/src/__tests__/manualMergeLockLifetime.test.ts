import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Response } from 'express';
import { runManualMerge } from '../routes/tasks/manualMergeService.js';
import { isProjectManualMergeActive } from '../routes/tasks/manualMergeGuards.js';
import { inspectProjectRunLock, acquireProjectRunLock, ProjectRunLockedError } from '../projectRunLock.js';
import type { MergeReadyTask } from '../routes/tasks/manualMergeTypes.js';

for (const conflict of [false, true]) {
  test(`manual merge holds its project lock until the ${conflict ? 'conflict' : 'fresh'} merge settles`, async (t) => {
    const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'lattice-manual-lock-'));
    t.after(() => fs.rm(projectPath, { recursive: true, force: true }));
    const task = { id: 'task', title: 'task', projectPath, status: 'ready_to_merge', createdAt: 1, branch: 'lattice/task', worktreePath: projectPath, conflict } as MergeReadyTask;
    const res = { status() { return this; }, json() { return this; } } as unknown as Response;
    let started!: () => void;
    const entered = new Promise<void>((resolve) => { started = resolve; });
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => { finish = resolve; });
    const merge = async () => { started(); await pending; return res; };
    const operation = runManualMerge(task, 'http://unused', res, { handleAlreadyConflictedMerge: merge, runFreshMerge: merge });
    try {
      await entered;
      // Let the old finally (which ran before the merge promise settled) run.
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal((await inspectProjectRunLock(projectPath))?.alive, true);
      assert.equal(isProjectManualMergeActive(projectPath), true);
      await assert.rejects(acquireProjectRunLock(projectPath, 'competing-merge'), ProjectRunLockedError);
    } finally {
      finish();
      await operation;
    }
    assert.equal(await inspectProjectRunLock(projectPath), null);
    assert.equal(isProjectManualMergeActive(projectPath), false);
  });
}
