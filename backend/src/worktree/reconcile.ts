import path from 'node:path';
import fs from 'node:fs/promises';
import { projectGit } from './projectGit.js';
import type { ExecResult } from './exec.js';
import { clearStaleInitializingLock } from './staleInitLock.js';
import { parseWorktreesPorcelain, type ParsedWorktree } from './state.js';
import { proxyKillSessionsByCwd } from '../terminalProxy.js';
import { pruneReparsePointsUnder } from './reparsePoints.js';
import { fsRmWithRetries } from './rmRetry.js';
import { isPathStrictlyInside } from './paths.js';
import { homeWorktreesDir } from '../projectPath.js';
import { assertNotReparsePoint, assertSafeWorktreePath } from './cleanupSafety.js';
import { archiveUncommittedWorktreeChanges } from './discardArchive.js';

// A busy candidate is preserved while setup tries "-r2" through "-r5".
export const MAX_PATH_RETRY_SUFFIXES = 4;
export const RM_RETRY_DELAYS_MS = [150, 400, 900];
const GIT_TIMEOUT_MS = 30_000;
// `worktree remove` deletes a whole checkout (7 GB on an LFS repo) — give it
// the same bounded-but-generous time cleanup.ts does.
const WORKTREE_REMOVE_TIMEOUT_MS = 5 * 60_000;
// Default pause after killing the candidate's PTYs so their handles on the
// checkout are released before the next recheck / removal.
const HANDLE_RELEASE_WAIT_MS = 200;

type ReconcileDeps = {
  projectGit: typeof projectGit;
  killSessions: (cwd: string) => Promise<unknown>;
  pruneReparsePoints: typeof pruneReparsePointsUnder;
  removeStray: typeof fsRmWithRetries;
  waitForHandles: () => Promise<void>;
  archiveUncommitted: typeof archiveUncommittedWorktreeChanges;
};

type ReconcileContext = {
  repoRoot: string;
  branchName: string;
  branchRef: string;
  worktreePath: string;
  candidateKey: string;
  deps: ReconcileDeps;
  git: (args: string[]) => Promise<ExecResult>;
  refuse: (reason: string) => false;
};

function pathKey(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function gitFailureDetail(result: ExecResult): string {
  return result.stderr.trim() || result.stdout.trim();
}

// Unlike access(), a permission failure must not mean "the path is absent".
async function entryExists(target: string): Promise<boolean> {
  try {
    await fs.lstat(target);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}

async function readTracked(ctx: ReconcileContext): Promise<ParsedWorktree[]> {
  const listed = await ctx.git(['worktree', 'list', '--porcelain', '-z']);
  if (listed.code !== 0) {
    throw new Error(`git worktree list failed (exit ${listed.code}): ${gitFailureDetail(listed)}`);
  }
  const tracked = parseWorktreesPorcelain(listed.stdout);
  if (tracked.length === 0) throw new Error('git worktree list returned no registrations');
  return tracked;
}

function validateRegistrations(ctx: ReconcileContext, tracked: ParsedWorktree[]): boolean {
  const { repoRoot, branchRef, candidateKey, refuse } = ctx;
  for (const entry of tracked) {
    const key = pathKey(entry.path);
    if (entry.branch === branchRef && key !== candidateKey) {
      return refuse(`branch is registered at another path: ${entry.path}`);
    }
    if (key === candidateKey && (entry.locked || entry.branch !== branchRef)) {
      return refuse(entry.locked ? 'Git worktree is locked' : 'path belongs to another branch or detached worktree');
    }
    if (isPathStrictlyInside(candidateKey, key)) {
      return refuse(`another registered worktree is nested inside the candidate: ${entry.path}`);
    }
    if (key !== pathKey(repoRoot) && isPathStrictlyInside(key, candidateKey)) {
      return refuse(`candidate is nested inside another registered worktree: ${entry.path}`);
    }
  }
  return true;
}

async function branchHasNoUnmergedCommits(ctx: ReconcileContext): Promise<boolean> {
  const { branchName, branchRef, worktreePath, refuse } = ctx;
  const unmerged = await ctx.git(['rev-list', '--count', `HEAD..${branchRef}`]);
  const count = unmerged.code === 0 ? parseInt(unmerged.stdout.trim(), 10) : NaN;
  if (!Number.isFinite(count)) {
    return refuse(`cannot count unmerged commits on ${branchName} (exit ${unmerged.code}): ${gitFailureDetail(unmerged)}`);
  }
  if (count > 0) {
    console.error(
      `[worktree] reconcile: branch ${branchName} has ${count} unmerged commit(s) — ` +
        `NOT deleting it or its checkout at ${worktreePath}; the new run will use a suffixed branch/path instead.`,
    );
    return refuse(`branch has ${count} unmerged commit(s)`);
  }
  return true;
}

// The candidate is a registered worktree: removal is delegated to Git.
async function removeRegisteredCandidate(ctx: ReconcileContext, interruptedAdd: boolean): Promise<boolean> {
  const { repoRoot, branchName, worktreePath, candidateKey, deps, refuse } = ctx;
  if (await entryExists(worktreePath)) {
    await deps.killSessions(worktreePath);
    await deps.waitForHandles();
    // Killing a PTY waits on another process. Recheck a move/lock/branch
    // change before the first filesystem mutation, including link pruning.
    const tracked = await readTracked(ctx);
    if (!validateRegistrations(ctx, tracked)) return false;
    if (!tracked.some((entry) => pathKey(entry.path) === candidateKey)) {
      return refuse('registration changed during reconciliation');
    }
    await assertNotReparsePoint(worktreePath);
    // A fresh Run starts fresh, but uncommitted edits in the old checkout
    // are still the user's work (reconcileStaleState's unmerged-commit guard
    // only covers commits). Archive them to ~/.lattice/snapshots/ first; if
    // that fails, keep the checkout and let setup take the -rN suffix.
    const archived = interruptedAdd
      ? { status: 'clean' as const }
      : await deps.archiveUncommitted(repoRoot, worktreePath, branchName);
    if (archived.status === 'failed') {
      return refuse(`could not archive uncommitted changes (${archived.error}); keeping the checkout`);
    }
    if (archived.status === 'archived') {
      console.warn(
        `[worktree] reconcile: archived ${archived.files} uncommitted change(s) from ${worktreePath} ` +
          `to ${archived.dir} before starting fresh`,
      );
    }
    await deps.pruneReparsePoints(worktreePath).catch((err) =>
      console.warn(`[worktree] reconcile: link pruning failed for ${worktreePath}:`, err),
    );
  }
  // Git also removes this exact registration when its directory is already
  // missing. No global prune is needed, and unrelated offline entries stay.
  const removed = await ctx.git(['worktree', 'remove', '--force', worktreePath]);
  if (removed.code !== 0) {
    return refuse(`git worktree remove failed (exit ${removed.code}): ${gitFailureDetail(removed)}`);
  }
  // Never run raw fs.rm after a registered removal, even if Git reported
  // success but a directory remains (or another writer replaced it).
  if (await entryExists(worktreePath)) return refuse('path remains after Git removal');
  return true;
}

// The candidate path exists but is not registered with Git. The caller has
// already confirmed the path exists.
async function removeUnregisteredStray(ctx: ReconcileContext): Promise<boolean> {
  const { repoRoot, worktreePath, candidateKey, deps, refuse } = ctx;
  // Only an unregistered home-scoped stray is eligible for filesystem
  // cleanup. A .git marker may belong to another repo or a moved worktree
  // whose registration needs repair; neither is ours to recursively erase.
  if (!isPathStrictlyInside(pathKey(homeWorktreesDir(repoRoot)), candidateKey)) {
    return refuse('unregistered path is outside the home worktrees directory');
  }
  if (await entryExists(path.join(worktreePath, '.git'))) {
    return refuse('unregistered path contains a .git marker');
  }
  await deps.killSessions(worktreePath);
  await deps.waitForHandles();
  const tracked = await readTracked(ctx);
  if (!validateRegistrations(ctx, tracked)) return false;
  if (tracked.some((entry) => pathKey(entry.path) === candidateKey)) {
    return refuse('path became registered during reconciliation');
  }
  await assertNotReparsePoint(worktreePath);
  if (await entryExists(path.join(worktreePath, '.git'))) {
    return refuse('a .git marker appeared during reconciliation');
  }
  if (!(await deps.removeStray(worktreePath, {
    delays: RM_RETRY_DELAYS_MS,
    logPrefix: '[worktree]',
    guardReparse: true,
  }))) return false;
  return true;
}

// The candidate branch exists and its checkout has been removed.
async function deleteCandidateBranch(ctx: ReconcileContext): Promise<boolean> {
  const { branchName, branchRef, refuse } = ctx;
  // A move/new checkout after removal must still preserve the branch. Git
  // supplies the final checked-out-branch guard for a concurrent checkout.
  const tracked = await readTracked(ctx);
  if (!validateRegistrations(ctx, tracked)) return false;
  if (tracked.some((entry) => entry.branch === branchRef)) {
    return refuse('branch remains checked out');
  }
  // Re-count: the first count ran before the PTY kill + handle wait +
  // archive, and a still-running agent from the previous run could commit
  // in that window. Removing the checkout lost nothing (the commit is on
  // the branch); deleting the branch now would.
  if (!(await branchHasNoUnmergedCommits(ctx))) return false;
  const deleted = await ctx.git(['branch', '-D', branchName]);
  if (deleted.code !== 0) {
    return refuse(`git branch delete failed (exit ${deleted.code}): ${gitFailureDetail(deleted)}`);
  }
  return true;
}

// Run explicitly starts fresh; Resume preserves prior progress. Only this
// exact managed candidate belongs to the fresh start. Sharing a branch name
// is insufficient: a user may have moved its worktree, or checked it out in
// main. Return false on a collision so setup can choose a different suffix.
export async function reconcileStaleState(
  repoRoot: string,
  branchName: string,
  worktreePath: string,
  overrides: Partial<ReconcileDeps> = {},
): Promise<boolean> {
  const deps: ReconcileDeps = {
    projectGit,
    killSessions: proxyKillSessionsByCwd,
    pruneReparsePoints: pruneReparsePointsUnder,
    removeStray: fsRmWithRetries,
    waitForHandles: () => new Promise((resolve) => setTimeout(resolve, HANDLE_RELEASE_WAIT_MS)),
    archiveUncommitted: archiveUncommittedWorktreeChanges,
    ...overrides,
  };
  const refuse = (reason: string): false => {
    console.warn(`[worktree] reconcile: preserving ${worktreePath}: ${reason}`);
    return false;
  };
  try {
    assertSafeWorktreePath(repoRoot, worktreePath);
    if (!path.isAbsolute(worktreePath) || !branchName.startsWith('lattice/')) {
      return refuse('candidate must have an absolute managed path and lattice/ branch');
    }
    await assertNotReparsePoint(worktreePath);
  } catch (err) {
    return refuse((err as Error).message);
  }

  const candidateKey = pathKey(worktreePath);
  const branchRef = `refs/heads/${branchName}`;
  const ctx: ReconcileContext = {
    repoRoot,
    branchName,
    branchRef,
    worktreePath,
    candidateKey,
    deps,
    git: (args) => deps.projectGit(repoRoot, args, {
      timeoutMs: args[0] === 'worktree' && args[1] === 'remove' ? WORKTREE_REMOVE_TIMEOUT_MS : GIT_TIMEOUT_MS,
    }),
    refuse,
  };

  let tracked = await readTracked(ctx);
  // A previous run of this exact candidate killed mid-`git worktree add`
  // leaves git's "initializing" lock; clear it rather than refusing forever.
  const initLocked = tracked.find((entry) => pathKey(entry.path) === candidateKey);
  // That checkout never finished, so no agent ever ran in it: nothing to archive
  // (its files all read as "untracked", so an archive would copy the whole tree).
  const interruptedAdd = !!initLocked && await clearStaleInitializingLock(repoRoot, initLocked);
  if (interruptedAdd) tracked = await readTracked(ctx);
  if (!validateRegistrations(ctx, tracked)) return false;
  const registration = tracked.find((entry) => pathKey(entry.path) === candidateKey);
  const branch = await ctx.git(['rev-parse', '--verify', '--quiet', branchRef]);
  if (branch.code !== 0 && branch.code !== 1) {
    throw new Error(`git branch lookup failed (exit ${branch.code}): ${gitFailureDetail(branch)}`);
  }
  if (branch.code === 0) {
    // A fresh Run reuses the task's canonical branch name — but "Move to
    // Open" from in_progress / ready_to_merge keeps `task.branch`, so this
    // candidate branch can still carry real, unmerged commits. Clearing it
    // (`worktree remove --force` + `branch -D`) would be the only copy of
    // that work gone, with no backup. Refuse before ANY mutation so setup
    // falls through to the next `-rN` suffix and the old branch (and its
    // checkout, uncommitted edits included) survives for the user.
    if (!(await branchHasNoUnmergedCommits(ctx))) return false;
  }

  if (registration) {
    if (!(await removeRegisteredCandidate(ctx, interruptedAdd))) return false;
  } else if (await entryExists(worktreePath)) {
    if (!(await removeUnregisteredStray(ctx))) return false;
  }

  if (branch.code === 0 && !(await deleteCandidateBranch(ctx))) return false;
  return true;
}
