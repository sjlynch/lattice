// Low-level worktree state checks: existence, git-dir resolution, mid-merge
// detection, and `git worktree list --porcelain` parsing. Read-only — these
// helpers run against either the project repo or a worktree, so they stay
// on the plain `exec` (not `projectGit`, which is project-repo-only).

import path from 'node:path';
import fs from 'node:fs/promises';
import { exec } from './exec.js';

export type ParsedWorktree = {
  path: string;
  branch?: string;
  detached?: boolean;
};

// Parse `git worktree list --porcelain` into an array of {path, branch?}.
// Each block is separated by a blank line and looks like:
//
//   worktree /abs/path
//   HEAD <sha>
//   branch refs/heads/<name>          (or 'detached')
//
// Used to recover from / sweep stale worktrees that survived a prior
// half-failed run.
export function parseWorktreesPorcelain(out: string): ParsedWorktree[] {
  const result: ParsedWorktree[] = [];
  for (const block of out.split(/\r?\n\r?\n/)) {
    if (!block.trim()) continue;
    const entry: ParsedWorktree = { path: '' };
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith('worktree ')) {
        entry.path = line.slice('worktree '.length).trim();
      } else if (line.startsWith('branch ')) {
        entry.branch = line.slice('branch '.length).trim();
      } else if (line === 'detached') {
        entry.detached = true;
      }
    }
    if (entry.path) result.push(entry);
  }
  return result;
}

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

// Single helper used at the top of every operation that mutates a project
// repo (merge, FF, finalize, cleanup, untrack). If `.git` has gone missing
// since the operation was scheduled, throw before we run any git command —
// `git` invoked in a directory without `.git` walks up looking for one and
// can latch onto a *different* repo's gitdir. We've seen the resulting
// confusion delete files in the wrong repo. Fail loud, fail fast.
export async function assertGitDirIntact(repoRoot: string): Promise<void> {
  if (!(await gitDirExists(repoRoot))) {
    throw new Error(
      `[lattice] refusing to operate: ${repoRoot}/.git is missing. ` +
        `The repository may have been corrupted by a prior run. ` +
        `Restore it (e.g. \`git init\` + \`git fetch origin\` + ` +
        `\`git reset --hard origin/main\`) before retrying.`,
    );
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

// `git merge --abort` in a worktree. Safe to call only after confirming
// isMidMerge — aborting when not mid-merge would error out. Returns
// `{ok:false, message}` so callers can fold the failure into their
// existing error path. Worktree-side, so it goes through plain `exec`,
// not projectGit (which forbids `merge` against the project repo).
export async function abortWorktreeMerge(
  worktreePath: string,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const r = await exec('git', ['merge', '--abort'], worktreePath);
  if (r.code !== 0) {
    return {
      ok: false,
      message: (r.stderr.trim() || r.stdout.trim() || 'git merge --abort failed').slice(0, 500),
    };
  }
  return { ok: true };
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
// `to` but not from `from`).
//
// THROWS on a non-zero git exit rather than returning a count. A transient
// git failure (a momentary `index.lock`, a brief Windows file lock, a
// worktree dir busy for an instant) must stay distinguishable from a genuine
// zero-commit result: callers that read a swallowed `0` as "no commits" would
// strand a task that actually has commits on its branch (the Stop hook fires
// exactly once, so there is no retry). Every caller either wraps this in
// try/catch (`/complete`, the in-progress sweep) or maps the throw onto an
// explicit error outcome (`checkBranchState`).
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
  if (r.code !== 0) {
    const detail = (r.stderr.trim() || r.stdout.trim() || `exit ${r.code}`).slice(
      0,
      500,
    );
    throw new Error(
      `git rev-list --count ${from}..${to} failed in ${repoRoot}: ${detail}`,
    );
  }
  const n = parseInt(r.stdout.trim(), 10);
  return Number.isFinite(n) ? n : 0;
}

// Count of commits on `branchName` that are not yet on HEAD. Throws on a git
// failure (see `countBetween`) so a transient error is never reported as 0.
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

// Returns true if the project repo's current HEAD is already an ancestor of
// the worktree branch's HEAD — i.e., the worktree already incorporates every
// commit that's on main. When true, a fresh `git merge main` in the worktree
// would be a no-op, and the branch can be fast-forwarded into main directly
// without re-merging. Used to short-circuit the "re-sync" path after a
// conflict resolver has committed and main hasn't moved since.
export async function mainIsAncestorOfWorktree(
  repoRoot: string,
  worktreePath: string,
): Promise<boolean> {
  const mainHead = await exec('git', ['rev-parse', 'HEAD'], repoRoot);
  if (mainHead.code !== 0 || !mainHead.stdout.trim()) return false;
  const sha = mainHead.stdout.trim();
  const r = await exec(
    'git',
    ['merge-base', '--is-ancestor', sha, 'HEAD'],
    worktreePath,
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
