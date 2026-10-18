import type { Task } from '../tasks.js';
import { exec } from '../worktree/exec.js';
import { projectGit } from '../worktree.js';
import { isReviewTestFile, type ReviewFile } from './prompt.js';

async function worktreeGit(task: Task, args: string[]): Promise<string> {
  if (!task.worktreePath) throw new Error('Task has no worktree');
  const result = await exec('git', args, task.worktreePath, { timeoutMs: 30_000 });
  if (result.code !== 0) throw new Error(`Review git failed: ${result.stderr.slice(0, 200)}`);
  return result.stdout;
}

export async function reviewHead(task: Task): Promise<string> {
  if (!task.branch) throw new Error('Task has no branch');
  // Read the branch ref in the project, including after an interrupted teardown
  // removed the checkout. No checkout/merge ever runs in the project repo.
  let result = await projectGit(task.projectPath, ['rev-parse', '--verify', `refs/heads/${task.branch}`], { timeoutMs: 30_000 });
  // If main caught up during review, ordinary cleanup may remove the now-
  // merged original ref. The durable kept ref still authenticates this intent.
  if (result.code !== 0 && task.review?.rerunPending && task.review.keptBranch) {
    result = await projectGit(task.projectPath, ['rev-parse', '--verify', `refs/heads/${task.review.keptBranch}`], { timeoutMs: 30_000 });
  }
  if (result.code !== 0 || !/^[a-f0-9]{40,64}$/.test(result.stdout.trim())) throw new Error('Cannot read task branch head');
  return result.stdout.trim();
}

export async function collectReviewFiles(task: Task, head: string): Promise<ReviewFile[]> {
  const main = await projectGit(task.projectPath, ['rev-parse', '--verify', 'HEAD'], { timeoutMs: 30_000 });
  if (main.code !== 0) throw new Error('Cannot read project HEAD');
  const base = (await worktreeGit(task, ['merge-base', head, main.stdout.trim()])).trim();
  // No renames: added files get (new file), deleted files retain their source.
  const names = (await worktreeGit(task, ['diff', '--no-renames', '--name-status', '-z', base, head])).split('\0');
  const files: ReviewFile[] = [];
  let diffLeft = 12_000;
  let sourceLeft = 14_000;
  const entries: { path: string; added: boolean; test: boolean }[] = [];
  for (let i = 0; i + 1 < names.length; i += 2) {
    if (names[i]) entries.push({ path: names[i + 1], added: names[i] === 'A', test: isReviewTestFile(names[i + 1]) });
  }
  // Fetch source hunks first so a large test diff never crowds out the fix.
  for (const entry of [...entries.filter((f) => !f.test), ...entries.filter((f) => f.test)]) {
    const diff = diffLeft > 0
      ? (await worktreeGit(task, ['diff', '--no-ext-diff', '--no-textconv', '--no-renames', base, head, '--', `:(literal)${entry.path}`])).slice(0, diffLeft)
      : '';
    diffLeft = Math.max(0, diffLeft - diff.length - 1);
    const before = !entry.test && sourceLeft > 0
      ? (entry.added ? '(new file)' : await worktreeGit(task, ['show', `${base}:${entry.path}`])).slice(0, sourceLeft)
      : '';
    sourceLeft = Math.max(0, sourceLeft - (entry.test ? 0 : entry.path.length + before.length + 4));
    files.push({ path: entry.path, diff, before, test: entry.test });
    if (diffLeft === 0 && sourceLeft === 0) break;
  }
  return files;
}

export async function keepReviewAttempt(task: Task, head: string): Promise<string> {
  const kept = `${task.branch}-attempt-1`;
  const existing = await projectGit(task.projectPath, ['rev-parse', '--verify', `refs/heads/${kept}`], { timeoutMs: 30_000 });
  if (existing.code === 0) {
    if (existing.stdout.trim() !== head) throw new Error(`Kept branch ${kept} already holds different work`);
    return kept;
  }
  const result = await projectGit(task.projectPath, ['branch', kept, head], { timeoutMs: 30_000 });
  if (result.code !== 0) throw new Error(`Cannot keep first attempt: ${result.stderr.slice(0, 200)}`);
  return kept;
}
