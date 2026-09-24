// Keep a task worktree mergeable after a `git merge` that died part-way.
//
// On 2026-09-24 a 22-task merge run hit a full disk. Each worktree-side
// `git merge <main>` had already written main's version of the files it
// updates — and, for files both sides changed, git's three-way result, or a
// zero-byte file where the write itself hit ENOSPC — before it failed to write
// the index ("sha1 file '…/index.lock' write error. Out of diskspace"). No
// MERGE_HEAD is left behind, so nothing recognised the state: the worktree just
// looked like it had uncommitted edits, and every later attempt refused with
// "Your local changes … would be overwritten by merge". 12 of the 22 worktrees
// were stuck that way.
//
// Two layers:
//   - `restoreFailedMergeWrites` — right after a worktree merge fails WITHOUT
//     leaving a merge in progress (not a conflict: ENOSPC, a hook, a lock, …),
//     put back every path the attempt touched: anything dirty now that was not
//     dirty before it started. Exact; nothing the agent left is involved.
//   - `clearMergeBlockingChanges` — before a merge, any uncommitted change to a
//     path main changed since the branch's merge base would make git refuse the
//     merge. That is the residue above when the restore itself failed (or the
//     backend died mid-merge), and occasionally an agent's own uncommitted
//     edit. Either way it was never going to be merged — Lattice merges the
//     branch's COMMITS — so copy every uncommitted change into the
//     keep-for-the-user archive (`../discardArchive.ts`) and then restore just
//     the blocking paths. A failed archive changes nothing and reports an error.
//
// Lattice-managed files (LATTICE_TASK.md, hook shims, …) are left to
// `runWorktreeMerge`'s own shelve/reset handling.

import fs from 'node:fs/promises';
import path from 'node:path';
import { exec } from '../exec.js';
import { parseStatus } from '../snapshot/pathClassification.js';
import { isPathInsideRepo } from '../paths.js';
import {
  archiveUncommittedWorktreeChanges,
  isManagedTrackedPath,
  isManagedUntrackedPath,
} from '../discardArchive.js';

const GIT_TIMEOUT_MS = 60_000;
// Pathspecs per `git restore`, well under Windows' 32K command-line limit.
const PATHS_PER_CALL = 100;

export type WorktreeDirtyPaths = {
  // In HEAD or the index: modified, deleted, staged-added.
  tracked: string[];
  untracked: string[];
};

async function worktreeGit(worktreePath: string, args: string[]) {
  return exec('git', args, worktreePath, { timeoutMs: GIT_TIMEOUT_MS });
}

// Uncommitted paths in the worktree, Lattice-managed files excluded. null when
// `git status` fails.
export async function readWorktreeDirtyPaths(worktreePath: string): Promise<WorktreeDirtyPaths | null> {
  const status = await worktreeGit(worktreePath, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  if (status.code !== 0) return null;
  const parsed = parseStatus(status.stdout);
  const inside = (f: string) => isPathInsideRepo(worktreePath, f);
  return {
    tracked: [...parsed.modified, ...(parsed.added ?? []), ...(parsed.deleted ?? [])]
      .filter((f) => inside(f) && !isManagedTrackedPath(f)),
    untracked: parsed.untracked.filter((f) => inside(f) && !isManagedUntrackedPath(f)),
  };
}

export function dirtyPathSet(dirty: WorktreeDirtyPaths): Set<string> {
  return new Set([...dirty.tracked, ...dirty.untracked]);
}

// Put `paths` back to HEAD: tracked ones via `git restore` (worktree AND index,
// so a staged merge result goes too; a path HEAD lacks is removed), untracked
// ones deleted — a single regular file, never a directory walk. Returns the
// paths it could not restore.
async function restorePathsToHead(worktreePath: string, dirty: WorktreeDirtyPaths): Promise<string[]> {
  const failed: string[] = [];
  const tracked = [...new Set(dirty.tracked)];
  for (let i = 0; i < tracked.length; i += PATHS_PER_CALL) {
    const chunk = tracked.slice(i, i + PATHS_PER_CALL);
    const r = await worktreeGit(worktreePath, ['restore', '--source=HEAD', '--staged', '--worktree', '--', ...chunk]);
    if (r.code !== 0) {
      console.warn(`[merge] could not restore ${chunk.length} path(s) in ${worktreePath}: ${r.stderr.trim() || r.stdout.trim()}`);
      failed.push(...chunk);
    }
  }
  for (const rel of new Set(dirty.untracked)) {
    const abs = path.join(worktreePath, rel);
    try {
      const st = await fs.lstat(abs);
      if (!st.isFile() && !st.isSymbolicLink()) {
        failed.push(rel);
        continue;
      }
      await fs.unlink(abs);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') failed.push(rel);
    }
  }
  return failed;
}

// After a worktree merge failed with no merge in progress: undo what the
// attempt wrote — every path dirty now that was not dirty in `before`.
// Best-effort (it runs right after a failure, possibly on a full disk); what
// it can't restore, `clearMergeBlockingChanges` handles on the next attempt.
export async function restoreFailedMergeWrites(
  worktreePath: string,
  before: ReadonlySet<string>,
): Promise<{ restored: number; failed: string[] }> {
  const now = await readWorktreeDirtyPaths(worktreePath);
  if (!now) return { restored: 0, failed: [] };
  const written: WorktreeDirtyPaths = {
    tracked: now.tracked.filter((f) => !before.has(f)),
    untracked: now.untracked.filter((f) => !before.has(f)),
  };
  const total = written.tracked.length + written.untracked.length;
  if (total === 0) return { restored: 0, failed: [] };
  const failed = await restorePathsToHead(worktreePath, written);
  console.warn(
    `[merge] failed merge in ${worktreePath} left ${total} partly-written path(s); ` +
      `restored ${total - failed.length} to the branch's HEAD` +
      (failed.length ? ` (${failed.length} could not be restored — the next merge attempt archives and clears them)` : ''),
  );
  return { restored: total - failed.length, failed };
}

// Paths main changed since the branch's merge base (the files `git merge
// <mainHeadSha>` will write). null when git can't say.
async function mainChangedPaths(worktreePath: string, mainHeadSha: string): Promise<Set<string> | null> {
  const base = await worktreeGit(worktreePath, ['merge-base', 'HEAD', mainHeadSha]);
  if (base.code !== 0 || !base.stdout.trim()) return null;
  const diff = await worktreeGit(worktreePath, ['diff', '--name-only', '--no-renames', '-z', base.stdout.trim(), mainHeadSha]);
  if (diff.code !== 0) return null;
  return new Set(diff.stdout.split('\0').filter(Boolean));
}

export type ClearBlockingResult =
  | { ok: true; cleared: number; archiveDir?: string }
  | { ok: false; message: string };

// Before a worktree merge: archive, then restore, every uncommitted change to a
// path main changed since the merge base. See the header.
export async function clearMergeBlockingChanges(
  repoRoot: string,
  worktreePath: string,
  branchName: string,
  mainHeadSha: string,
): Promise<ClearBlockingResult> {
  const dirty = await readWorktreeDirtyPaths(worktreePath);
  if (!dirty || dirty.tracked.length + dirty.untracked.length === 0) return { ok: true, cleared: 0 };
  const touched = await mainChangedPaths(worktreePath, mainHeadSha);
  if (!touched) return { ok: true, cleared: 0 }; // let git itself report whatever is wrong
  const blocking: WorktreeDirtyPaths = {
    tracked: dirty.tracked.filter((f) => touched.has(f)),
    untracked: dirty.untracked.filter((f) => touched.has(f)),
  };
  const total = blocking.tracked.length + blocking.untracked.length;
  if (total === 0) return { ok: true, cleared: 0 };

  const archive = await archiveUncommittedWorktreeChanges(repoRoot, worktreePath, branchName);
  if (archive.status === 'failed') {
    return {
      ok: false,
      message:
        `The worktree has uncommitted changes to ${total} file(s) main also changed (usually left by a merge ` +
        `that failed part-way), and they could not be archived before clearing them: ${archive.error}. ` +
        'Nothing was changed; free disk space and retry the merge.',
    };
  }
  const failed = await restorePathsToHead(worktreePath, blocking);
  const where = archive.status === 'archived' ? ` (a copy of every uncommitted change is kept in ${archive.dir})` : '';
  if (failed.length > 0) {
    return {
      ok: false,
      message:
        `Could not clear ${failed.length} uncommitted file(s) that block merging main into ${branchName}` +
        `${where}: ${failed.slice(0, 5).join(', ')}${failed.length > 5 ? ', …' : ''}`,
    };
  }
  console.warn(
    `[merge] ${worktreePath}: cleared ${total} uncommitted change(s) to files main also changed ` +
      `(left by an earlier merge that failed part-way, or never committed)${where}`,
  );
  return { ok: true, cleared: total, ...(archive.status === 'archived' ? { archiveDir: archive.dir } : {}) };
}
