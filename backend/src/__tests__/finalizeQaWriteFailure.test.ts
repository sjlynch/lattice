import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { finalizeMergedTask } from '../worktree/finalize.js';
import type { Task } from '../tasks.js';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

// Regression: finalize ignored updateTaskCrashSafe's null (disk write failed /
// task gone) and still scheduled worktree + branch cleanup and reported
// {ok:true}. The task then sat at ready_to_merge pointing at a deleted branch,
// so no retry could ever finalize it. Now the worktree and branch are kept and
// the caller gets an error it can surface and retry.
test('finalize keeps the worktree and branch when the qa state cannot be recorded', async () => {
  const stamp = `${Date.now()}_${process.pid}`;
  const base = await fs.mkdtemp(path.join(os.tmpdir(), `lattice-finalize-qa-${stamp}-`));
  const projectPath = path.join(base, 'repo');
  const wt = path.join(base, 'wt');
  const branch = `lattice/qa-${stamp}`;
  await fs.mkdir(projectPath, { recursive: true });
  try {
    git(projectPath, ['init', '-q', '-b', 'main']);
    git(projectPath, ['config', 'user.email', 't@t']);
    git(projectPath, ['config', 'user.name', 'lattice-test']);
    await fs.writeFile(path.join(projectPath, 'a.txt'), 'a\n', 'utf8');
    git(projectPath, ['add', '-A']);
    git(projectPath, ['commit', '-q', '-m', 'init']);
    git(projectPath, ['worktree', 'add', '-q', wt, '-b', branch]);
    await fs.writeFile(path.join(wt, 'a.txt'), 'b\n', 'utf8');
    git(wt, ['commit', '-q', '-am', 'change']);

    // A task the store does not hold: updateTaskCrashSafe resolves null,
    // exactly as it does when its disk write fails.
    const task: Task = {
      id: `missing-${stamp}`,
      projectPath,
      title: 'qa write failure fixture',
      status: 'ready_to_merge',
      createdAt: Date.now(),
      branch,
      worktreePath: wt,
    };

    const result = await finalizeMergedTask(task, 'http://127.0.0.1:5184');
    assert.equal(result.ok, false);
    assert.ok('error' in result && /qa state could not be saved/.test(result.error));

    // main did fast-forward (that part is idempotent on retry)...
    assert.equal(git(projectPath, ['rev-parse', 'main']).trim(), git(projectPath, ['rev-parse', branch]).trim());
    // ...but nothing the task still points at was torn down.
    await new Promise((r) => setTimeout(r, 200));
    await assert.doesNotReject(fs.access(wt));
    assert.match(git(projectPath, ['branch', '--list', branch]), new RegExp(branch.replace('/', '\\/')));
  } finally {
    try { git(projectPath, ['worktree', 'remove', '--force', wt]); } catch { /* ignore */ }
    await fs.rm(base, { recursive: true, force: true }).catch(() => {});
  }
});
