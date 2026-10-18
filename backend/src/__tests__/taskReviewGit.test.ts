// Reviewer context must come from the task's merge-base, never the changed
// checkout or current main. Kept attempts are non-forced refs, not lost work.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { exec } from '../worktree/exec.js';
import { collectReviewFiles, keepReviewAttempt, reviewHead } from '../taskReview/git.js';
import type { Task } from '../tasks.js';
import { cleanupWorktreeForTask, projectGit } from '../worktree.js';
import { buildWorktreeCandidatePlan } from '../worktree/setupCandidates.js';
import { addWorktreeWithRetries } from '../worktree/setupAdd.js';
import { reconcileStaleState } from '../worktree/reconcile.js';
import { withTempDir, writeLayout } from './helpers/tempDir.js';

test('git context is source-first, excludes test source, and preserves the original merge-base content', async () => {
  await withTempDir('review-git-', async (root) => {
    const project = path.join(root, 'project');
    await fs.mkdir(project);
    const plan = buildWorktreeCandidatePlan(project, { id: 't_100_test', title: 'Task' });
    const checkout = plan.candidates[0].candidatePath;
    const branch = plan.candidates[0].candidateBranch;
    const git = async (cwd: string, args: string[]) => {
      const result = await exec('git', args, cwd);
      assert.equal(result.code, 0, result.stderr);
      return result.stdout.trim();
    };
    const commit = (cwd: string) => git(cwd, ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'fixture']);
    await git(project, ['init', '-b', 'main']);
    await writeLayout(project, { 'z.ts': 'original source\n', 'old.ts': 'deleted source\n', 'a.test.ts': 'old test\n' });
    await git(project, ['add', '.']); await commit(project);
    await git(project, ['worktree', 'add', '-b', branch, checkout, 'HEAD']);
    let freshCheckout: string | undefined;
    let removed = false;
    try {
      await writeLayout(checkout, { 'z.ts': 'fixed source\n', 'new file.ts': 'new source\n', 'a.test.ts': 'new test\n' });
      await fs.unlink(path.join(checkout, 'old.ts'));
      await git(checkout, ['add', '.']); await commit(checkout);
      // Main advanced in parallel. The reviewer still needs the task's base.
      await writeLayout(project, { 'z.ts': 'newer main source\n' });
      await git(project, ['add', '.']); await commit(project);
      const task: Task = { id: 't_100_test', title: 'Task', projectPath: project, worktreePath: checkout,
        branch, status: 'in_progress', createdAt: 1 };
      const head = await reviewHead(task);
      const files = await collectReviewFiles(task, head);
      assert.equal(files.find((file) => file.path === 'z.ts')?.before, 'original source\n');
      assert.equal(files.find((file) => file.path === 'old.ts')?.before, 'deleted source\n');
      assert.equal(files.find((file) => file.path === 'new file.ts')?.before, '(new file)');
      assert.equal(files.at(-1)?.path, 'a.test.ts');
      assert.equal(files.at(-1)?.before, '');
      assert.match(files.find((file) => file.path === 'z.ts')!.diff, /-original source\n\+fixed source/);
      const kept = await keepReviewAttempt(task, head);
      assert.equal(kept, `${branch}-attempt-1`);
      assert.equal(await git(project, ['rev-parse', kept]), head);
      assert.equal(await keepReviewAttempt(task, head), kept, 'restart is idempotent');
      const main = await git(project, ['rev-parse', 'main']);
      await assert.rejects(keepReviewAttempt(task, main), /already holds different work/);
      assert.equal(await git(project, ['rev-parse', kept]), head, 'existing unmerged commits are never overwritten');
      assert.equal(await fs.readFile(path.join(project, 'z.ts'), 'utf8'), 'newer main source\n');
      // Exercise the real teardown with terminal I/O injected, then the normal
      // fresh-candidate path. Attempt 1's only commits must remain on its ref,
      // and the new checkout must start at current main, not the rejected head.
      assert.equal(await cleanupWorktreeForTask(project, checkout, branch, {
        projectGit, proxyKillSessionsByCwd: async () => {}, notifySessionsFreed: () => {}, notifyDiskSpaceFreed: () => {},
      }, { keepBranchIfUnmerged: true }), true);
      removed = true;
      assert.equal(await git(project, ['rev-parse', kept]), head);
      const fresh = await addWorktreeWithRetries(project, plan, task.title, undefined, {
        reconcile: (repo, ref, cwd) => reconcileStaleState(repo, ref, cwd, {
          killSessions: async () => {}, waitForHandles: async () => {},
        }),
      });
      freshCheckout = fresh.candidatePath;
      assert.notEqual(fresh.candidateBranch, branch, 'unmerged original branch is also kept');
      assert.equal(await git(freshCheckout, ['rev-parse', 'HEAD']), main);
      assert.equal((await fs.readFile(path.join(freshCheckout, 'z.ts'), 'utf8')).replace(/\r\n/g, '\n'), 'newer main source\n');
      assert.equal(await git(project, ['rev-parse', kept]), head);
    } finally {
      if (!removed) await git(project, ['worktree', 'remove', '--force', checkout]);
      if (freshCheckout) await git(project, ['worktree', 'remove', '--force', freshCheckout]);
    }
  });
});
