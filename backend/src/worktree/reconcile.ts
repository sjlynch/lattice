import path from 'node:path';
import fs from 'node:fs/promises';
import { projectGit } from './projectGit.js';
import { worktreeExists, parseWorktreesPorcelain } from './state.js';
import { proxyKillSessionsByCwd } from '../terminalProxy.js';
import { assertNotReparsePoint } from './cleanup.js';
import { homeWorktreesDir } from '../projectPath.js';

// How many alternate worktree paths to try when the canonical path can't be
// freed (Windows lock that survives PTY kills + retries — usually an Explorer
// window or the user's editor). 4 retries gives us "-r2" through "-r5",
// after which the user almost certainly has a runaway process and should be
// told to look rather than us silently spawning more orphans.
export const MAX_PATH_RETRY_SUFFIXES = 4;
export const RM_RETRY_DELAYS_MS = [150, 400, 900];

// Branch names are deterministic from (slug, shortId), so a leftover
// branch/worktree from before will collide with `git worktree add -b`.
// Run = fresh start; the explicit Resume path is the one that
// preserves prior progress.
//
// Returns true if the (path, branch) pair is now free for `git worktree add`,
// false if something on disk couldn't be removed (Windows lock that survived
// PTY kills + retries). Caller falls back to an alternate suffix.
export async function reconcileStaleState(
  repoRoot: string,
  branchName: string,
  worktreePath: string,
): Promise<boolean> {
  const branchExists =
    (
      await projectGit(
        repoRoot,
        ['rev-parse', '--verify', '--quiet', `refs/heads/${branchName}`],
      )
    ).code === 0;
  const targetDirExists = await worktreeExists(worktreePath);

  if (!branchExists && !targetDirExists) return true;

  const wtList = await projectGit(repoRoot, ['worktree', 'list', '--porcelain']);
  const tracked = parseWorktreesPorcelain(wtList.stdout);
  const onBranch = tracked.find(
    (w) => w.branch === `refs/heads/${branchName}`,
  );
  if (onBranch) {
    // Tracked worktree on this branch — remove it cleanly first.
    // Kill any PTYs whose cwd is inside the dir before git tries to remove it,
    // otherwise on Windows the cwd lock makes `git worktree remove` fail.
    await proxyKillSessionsByCwd(onBranch.path);
    await new Promise<void>((r) => setTimeout(r, 200));
    const rm = await projectGit(
      repoRoot,
      ['worktree', 'remove', '--force', onBranch.path],
    );
    if (rm.code !== 0) {
      console.warn(
        `[worktree] reconcile: 'git worktree remove --force ${onBranch.path}' ` +
          `exit ${rm.code}: ${rm.stderr.trim() || rm.stdout.trim()}`,
      );
    }
  }
  if (await worktreeExists(worktreePath)) {
    // Untracked stray directory at our target path — wipe it. This is the
    // path most likely to hit EBUSY: the qa-cleanup background job already
    // tried (and may have failed) once, leaving the dir orphaned. Kill any
    // PTYs whose cwd is inside, give the OS a beat, then retry the rm a
    // few times before giving up.
    //
    // worktreePath is always a fresh candidate under homeWorktreesDir(repoRoot)
    // — i.e. ~/.lattice/worktrees/<hash>/… — so this fs.rm is structurally
    // incapable of touching any project's `.git`. The startsWith guard plus
    // the reparse-point check in tryRmWithRetries are belt-and-suspenders.
    const resolvedWt = path.resolve(worktreePath);
    const resolvedBase = path.resolve(homeWorktreesDir(repoRoot));
    if (!resolvedWt.startsWith(resolvedBase + path.sep)) {
      console.error(
        `[worktree] reconcile: refusing rm on "${resolvedWt}" — ` +
          `not under "${resolvedBase}". Skipping cleanup.`,
      );
      return false;
    }
    await proxyKillSessionsByCwd(worktreePath);
    await new Promise<void>((r) => setTimeout(r, 200));
    if (!(await tryRmWithRetries(worktreePath))) {
      // Caller will move on to a fresh suffix; leave the orphan dir in
      // place so the user can investigate the lock holder.
      return false;
    }
  }
  await projectGit(repoRoot, ['worktree', 'prune']);
  if (branchExists) {
    // -D in case it has unmerged commits from a prior abandoned run.
    // (branchName is always `lattice/<slug>-<id>` — projectGit's branch-delete
    // guard requires the `lattice/` prefix.)
    const del = await projectGit(repoRoot, ['branch', '-D', branchName]);
    if (del.code !== 0) {
      console.warn(
        `[worktree] reconcile: 'git branch -D ${branchName}' ` +
          `exit ${del.code}: ${del.stderr.trim() || del.stdout.trim()}`,
      );
      return false;
    }
  }
  return true;
}

// `fs.rm` on Windows fails with EBUSY/EPERM/ENOTEMPTY when something
// holds a handle on the directory. Most lock holders we care about (PTYs)
// have already been killed by the caller; this gives the OS a few hundred
// ms to actually release the handle before declaring defeat.
export async function tryRmWithRetries(target: string): Promise<boolean> {
  // Reparse-point guard before any retry. If the path is a symlink or
  // Windows junction, fs.rm would recurse into the target and delete it —
  // catastrophic if the junction happened to point at the repo root or
  // its `.git`. Refuse loud and skip the rm entirely.
  try {
    await assertNotReparsePoint(target);
  } catch (err) {
    console.error((err as Error).message);
    return false;
  }
  for (let attempt = 0; attempt < RM_RETRY_DELAYS_MS.length + 1; attempt += 1) {
    try {
      await fs.rm(target, { recursive: true, force: true });
      return true;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      const transient =
        code === 'EBUSY' || code === 'EPERM' || code === 'ENOTEMPTY';
      if (!transient || attempt === RM_RETRY_DELAYS_MS.length) {
        console.warn(`[worktree] fs.rm ${target} failed (${code ?? 'unknown'}):`, err);
        return false;
      }
      await new Promise<void>((r) =>
        setTimeout(r, RM_RETRY_DELAYS_MS[attempt]),
      );
    }
  }
  return false;
}
