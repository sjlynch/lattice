// Low-level worktree state checks: existence, git-dir resolution, mid-merge
// detection. Used by both setup and merge logic.

import path from 'node:path';
import fs from 'node:fs/promises';
import { exec } from './exec.js';

export async function worktreeExists(worktreePath: string): Promise<boolean> {
  try {
    await fs.access(worktreePath);
    return true;
  } catch {
    return false;
  }
}

// Sentinel for catastrophic state: a missing `<repoRoot>/.git` means every
// subsequent git operation will either fail destructively or be unpredictable.
// Callers (fastForwardMain, the run-level stash preflight) bail loud on false
// instead of pressing on into a deletion cascade.
export async function gitDirExists(repoRoot: string): Promise<boolean> {
  try {
    await fs.access(path.join(repoRoot, '.git'));
    return true;
  } catch {
    return false;
  }
}

// Resolve a worktree's git-dir (where MERGE_HEAD etc. live). Worktrees
// store their per-worktree state under <main-repo>.git/worktrees/<name>,
// not in <worktree>/.git (which is just a file pointer).
async function getWorktreeGitDir(worktreePath: string): Promise<string | null> {
  const r = await exec('git', ['rev-parse', '--git-dir'], worktreePath);
  if (r.code !== 0) return null;
  return path.resolve(worktreePath, r.stdout.trim());
}

// True if the worktree (or main repo) is mid-merge — i.e., a MERGE_HEAD
// file exists in its git-dir.
export async function isMidMerge(dir: string): Promise<boolean> {
  const gitDir = await getWorktreeGitDir(dir);
  if (!gitDir) return false;
  try {
    await fs.access(path.join(gitDir, 'MERGE_HEAD'));
    return true;
  } catch {
    return false;
  }
}

// Returns true if a local branch with this exact name exists.
export async function checkBranchExists(
  repoRoot: string,
  branchName: string,
): Promise<boolean> {
  const r = await exec('git', ['branch', '--list', branchName], repoRoot);
  return r.stdout.trim().length > 0;
}

// Count of commits in the range `from..to` (i.e., commits reachable from
// `to` but not from `from`). Returns 0 on any failure.
export async function countBetween(
  repoRoot: string,
  from: string,
  to: string,
): Promise<number> {
  const r = await exec(
    'git',
    ['rev-list', '--count', `${from}..${to}`],
    repoRoot,
  );
  if (r.code !== 0) return 0;
  const n = parseInt(r.stdout.trim(), 10);
  return Number.isFinite(n) ? n : 0;
}

// Count of commits on `branchName` that are not yet on HEAD.
export async function branchCommitCount(
  repoRoot: string,
  branchName: string,
): Promise<number> {
  return countBetween(repoRoot, 'HEAD', branchName);
}

// Returns true if the branch is fully reachable from HEAD — i.e., it
// has already been merged in (and possibly more commits have happened on
// HEAD since). `git merge-base --is-ancestor` is exit 0 when ancestor.
export async function branchIsAncestorOfHead(
  repoRoot: string,
  branchName: string,
): Promise<boolean> {
  const r = await exec(
    'git',
    ['merge-base', '--is-ancestor', branchName, 'HEAD'],
    repoRoot,
  );
  return r.code === 0;
}

export async function listConflictedFiles(repoRoot: string): Promise<string[]> {
  const conflicts = await exec(
    'git',
    ['diff', '--name-only', '--diff-filter=U'],
    repoRoot,
  );
  return conflicts.stdout
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}
