// Clear the lock an interrupted `git worktree add` leaves behind.
//
// `git worktree add` locks the new registration with the reason
// "initializing" while it checks the tree out and removes that lock when it
// finishes. Kill it part-way (a backend stop mid-checkout — on a large repo a
// checkout takes minutes, 2026-09-22) and the lock stays forever. Every
// teardown path here honours worktree locks as a user's explicit "keep this"
// (cleanup, reconcile, the boot sweep), so the half-written checkout — up to
// several GB — was stranded for good.
//
// A lock is cleared only when it is certainly git's own leftover: reason
// exactly "initializing", checkout under a Lattice-managed worktrees dir, and
// the lock file older than STALE_AFTER_MS (no live add takes that long, and a
// user's own lock carries their reason, not git's). The unlock goes through
// projectGit (`worktree unlock` is on its whitelist); the normal guarded
// teardown then takes over, archive step included.

import fs from 'node:fs/promises';
import path from 'node:path';
import { projectGit } from './projectGit.js';
import { isUnderManagedWorktreesDir } from './cleanupSafety.js';
import type { ParsedWorktree } from './state.js';

const STALE_AFTER_MS = 10 * 60_000;
// `git worktree unlock` only deletes a metadata file; the bound only stops a
// wedged git from stalling the sweep.
const GIT_UNLOCK_TIMEOUT_MS = 15_000;
export const GIT_INIT_LOCK_REASON = 'initializing';

export type StaleInitLockDeps = {
  lockFileMtimeMs: (worktreePath: string, repoRoot: string) => Promise<number | null>;
  unlock: (repoRoot: string, worktreePath: string) => Promise<boolean>;
  now: () => number;
};

async function lockFileMtimeMs(worktreePath: string, repoRoot: string): Promise<number | null> {
  // The admin dir is named in the checkout's `.git` file (`gitdir: <path>`);
  // fall back to the conventional `<repo>/.git/worktrees/<basename>`.
  let adminDir = path.join(repoRoot, '.git', 'worktrees', path.basename(worktreePath));
  try {
    const dotGit = await fs.readFile(path.join(worktreePath, '.git'), 'utf8');
    const m = /^gitdir:\s*(.+)$/m.exec(dotGit);
    if (m) adminDir = path.resolve(worktreePath, m[1].trim());
  } catch {
    /* checkout gone or not a gitfile — use the fallback */
  }
  try {
    return (await fs.stat(path.join(adminDir, 'locked'))).mtimeMs;
  } catch {
    return null;
  }
}

const defaultDeps: StaleInitLockDeps = {
  lockFileMtimeMs,
  unlock: async (repoRoot, worktreePath) =>
    (await projectGit(repoRoot, ['worktree', 'unlock', worktreePath], { timeoutMs: GIT_UNLOCK_TIMEOUT_MS })).code === 0,
  now: () => Date.now(),
};

// True when `wt` carried a stale "initializing" lock that is now cleared.
export async function clearStaleInitializingLock(
  repoRoot: string,
  wt: ParsedWorktree,
  deps: StaleInitLockDeps = defaultDeps,
): Promise<boolean> {
  if (!wt.locked || wt.lockReason !== GIT_INIT_LOCK_REASON) return false;
  if (!isUnderManagedWorktreesDir(wt.path, repoRoot)) return false;
  const mtime = await deps.lockFileMtimeMs(wt.path, repoRoot);
  if (mtime === null || deps.now() - mtime < STALE_AFTER_MS) return false;
  if (!(await deps.unlock(repoRoot, wt.path))) return false;
  console.warn(
    `[worktree] cleared the stale "${GIT_INIT_LOCK_REASON}" lock on ${wt.path} ` +
      '(a `git worktree add` was interrupted mid-checkout)',
  );
  return true;
}
