import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createTask, getTask, updateTask } from '../tasks.js';
import { createRunState, type MergeRun } from '../mergeRuns/state.js';
import { handleResyncOutcome } from '../mergeRuns/resolverSpawn/handleOutcome.js';
import { release, tryAcquire } from '../mergeLocks.js';

for (const reason of ['resolver-idle', 'timeout', 'resolver-dead'] as const) {
  test(`${reason} stops the real merge consumer without clearing persisted conflicts or worktree edits`, async () => {
    const project = await fs.mkdtemp(path.join(os.tmpdir(), 'lattice-preserve-resolver-'));
    try {
      const seed = await createTask(project, 'Preserve resolver');
      const task = (await updateTask(seed.id, { status: 'ready_to_merge', conflict: true, conflictStartedAt: 123, worktreePath: project }))!;
      const edit = path.join(project, 'unfinished.txt');
      await fs.writeFile(edit, 'valuable unfinished resolution');
      const run: MergeRun = { id: `run-${reason}`, projectPath: project, status: 'running', startedAt: 1,
        total: 1, processed: 0, merged: [], conflicted: [], errored: [], cancelRequested: false };
      const state = createRunState();
      const lock = tryAcquire(task.id)!;
      try {
        const outcome = await handleResyncOutcome(task, run, { state, projectPath: project, backendOrigin: 'http://unused', baselineHead: null },
          { kind: 'merge-conflict', cwd: project, command: 'resolver', relativePath: 'MERGE_INSTRUCTIONS.md', conflictedFiles: ['unfinished.txt'] }, lock, {
            recordAndSpawn: async () => ({ kind: 'spawned', serverId: 'resolver' }),
            parkOnConflictResolver: async (_state, _run, token) => { release(token); return reason; },
          });
        assert.equal(outcome.kind, 'awaiting-resolver');
        assert.equal(run.cancelRequested, true);
        assert.equal((await getTask(task.id))?.conflict, true);
        assert.equal((await getTask(task.id))?.conflictStartedAt, 123);
        assert.equal(await fs.readFile(edit, 'utf8'), 'valuable unfinished resolution');
        assert.match(run.errored.at(-1)!.error, /preserved/);
      } finally { release(lock); }
    } finally { await fs.rm(project, { recursive: true, force: true }); }
  });
}
