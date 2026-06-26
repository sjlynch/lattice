import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { finalizeMergedTask } from '../worktree/finalize.js';
import {
  createTask,
  updateTask,
  getTask,
  deleteTask,
  flushPersist,
} from '../tasks.js';
import { homeProjectDir } from '../projectPath.js';

const ORIGIN = 'http://127.0.0.1:5184';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

// Regression for: a finalize re-sync that conflicts returned a bare
// `{ok:false,error}` — no MERGE_INSTRUCTIONS.md, no task.conflict flag, and the
// FinalizeOutcome type couldn't even express a resolvable conflict, so no caller
// could spawn a resolver. The task was stranded at ready_to_merge with a
// leftover mid-merge worktree.
//
// Scenario: two ready_to_merge tasks whose branches both edit the SAME line.
// Task A finalizes first and fast-forwards main onto that hunk. Task B then
// finalizes: its first fast-forward fails (main advanced), so finalize
// re-syncs main into B's worktree — which conflicts on the shared line. The
// fix makes that re-sync conflict resolvable, exactly like a first-pass merge
// conflict: write MERGE_INSTRUCTIONS.md, flag the task, and return a
// merge-conflict outcome the caller can use to spawn a resolver.
test('finalize re-sync conflict yields a resolvable merge-conflict (not a bare error) and writes MERGE_INSTRUCTIONS.md', async () => {
  const stamp = `${Date.now()}_${process.pid}`;
  const base = await fs.mkdtemp(
    path.join(os.tmpdir(), `lattice-finalize-resync-${stamp}-`),
  );
  const projectPath = path.join(base, 'repo');
  const wtA = path.join(base, 'wtA');
  const wtB = path.join(base, 'wtB');
  await fs.mkdir(projectPath, { recursive: true });

  // --- Build a real repo: one file, one tracked line both branches edit. ---
  git(projectPath, ['init', '-q']);
  git(projectPath, ['config', 'user.email', 't@t']);
  git(projectPath, ['config', 'user.name', 'lattice-test']);
  await fs.writeFile(path.join(projectPath, 'stamp.txt'), 'stamp = 0\n', 'utf8');
  git(projectPath, ['add', '-A']);
  git(projectPath, ['commit', '-q', '-m', 'init']);

  // Both worktrees branch from the same base commit, then edit the same line.
  git(projectPath, ['worktree', 'add', '-q', wtA, '-b', `lattice/a-${stamp}`]);
  await fs.writeFile(path.join(wtA, 'stamp.txt'), 'stamp = A\n', 'utf8');
  git(wtA, ['add', '-A']);
  git(wtA, ['commit', '-q', '-m', 'set stamp A']);

  git(projectPath, ['worktree', 'add', '-q', wtB, '-b', `lattice/b-${stamp}`]);
  await fs.writeFile(path.join(wtB, 'stamp.txt'), 'stamp = B\n', 'utf8');
  git(wtB, ['add', '-A']);
  git(wtB, ['commit', '-q', '-m', 'set stamp B']);

  // Task A finalizes first: its branch fast-forwards main onto the shared
  // hunk. (Modeled with a direct ff-only so the test stays deterministic and
  // doesn't race A's background worktree cleanup against B's finalize — the
  // behavior under test is entirely in B's finalize.)
  git(projectPath, ['merge', '--ff-only', `lattice/a-${stamp}`]);

  // Task B is the ready_to_merge task we finalize through the real function.
  const task = await createTask(projectPath, 'finalize re-sync conflict fixture');
  await updateTask(task.id, {
    status: 'ready_to_merge',
    branch: `lattice/b-${stamp}`,
    worktreePath: wtB,
  });
  const taskB = (await getTask(task.id))!;

  try {
    const result = await finalizeMergedTask(taskB, ORIGIN);

    // It must NOT be a bare error — it must be a resolvable merge conflict.
    assert.equal(result.ok, false);
    assert.equal(
      'error' in result,
      false,
      'a re-sync conflict must not surface as a bare {ok:false,error}',
    );
    assert.ok(
      'mergeConflict' in result,
      'finalize must return a merge-conflict outcome the caller can act on',
    );
    if (!('mergeConflict' in result)) return; // narrow for TS
    assert.deepEqual(result.mergeConflict, ['stamp.txt']);
    assert.equal(result.cwd, wtB);
    assert.match(result.resolveCommand, /MERGE_INSTRUCTIONS\.md/);

    // MERGE_INSTRUCTIONS.md must exist in the worktree so the spawned resolver
    // Claude has something to read.
    await assert.doesNotReject(
      fs.access(path.join(wtB, 'MERGE_INSTRUCTIONS.md')),
      'MERGE_INSTRUCTIONS.md should be written into the conflicted worktree',
    );

    // The task must be flagged conflicted so the UI / merge-run can re-spawn a
    // resolver and the worktree isn't stranded.
    const after = await getTask(task.id);
    assert.equal(after?.conflict, true, 'task.conflict must be set');
    assert.ok(after?.conflictStartedAt, 'conflictStartedAt must be stamped');
  } finally {
    await deleteTask(task.id);
    await flushPersist(projectPath).catch(() => {});
    await fs
      .rm(homeProjectDir(projectPath), { recursive: true, force: true })
      .catch(() => {});
    await fs.rm(base, { recursive: true, force: true }).catch(() => {});
  }
});
