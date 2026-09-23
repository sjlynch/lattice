// Tear down a worktree: kill any terminals running inside it (so Windows
// releases file locks), then remove the worktree and branch via git.
//
// No raw `fs.rm` here anymore. Every prior `.git`-deletion incident on
// this project traced back to a recursive filesystem delete (directly via
// `fs.rm`, or indirectly via a lost `git stash --include-untracked`)
// reaching something it shouldn't. So cleanup delegates the recursive
// directory removal entirely to `git worktree remove --force`: git knows
// exactly which directory the worktree is (from its registration), refuses
// to remove the main worktree, and doesn't follow symlinks out. If that
// command fails (typically a Windows lock that outlived the PTY kill), we
// LEAVE the directory in place — an orphan under `~/.lattice/worktrees/`
// is inert. If git still has it registered, the boot-time sweep
// (`sweepOrphanedWorktrees` in recovery.ts) retries it later, branch and
// all; if git already dropped the registration (its usual behaviour on a
// part-failed remove), the files are residue for
// `recovery/worktreeResidueSweep.ts` and the branch step runs now — nothing
// would ever see that branch again otherwise. Worktrees now live outside the project
// tree (`~/.lattice/worktrees/<hash>/…`), so even an orphan is structurally
// incapable of affecting any project's `.git`.
//
// Every git invocation here has a hard timeout — a hung process holding
// the worktree dir open on Windows would otherwise wedge cleanup forever
// and stall the run worker (which awaits cleanup mid-iteration).
//
// Path-safety bounds + reparse-point guard live in `cleanupSafety.ts`;
// the in-worktree junction/symlink stripper lives in `reparsePoints.ts`.

import fs from 'node:fs/promises';
import path from 'node:path';
import { projectGit } from './projectGit.js';
// Canonical source of the branch-delete guard — imported (not re-declared)
// so this pre-check can't drift from the policy that would actually throw.
import { LATTICE_BRANCH_RE } from './projectGit/policy.js';
import { proxyKillSessionsByCwd } from '../terminalProxy.js';
import { notifyDiskSpaceFreed, notifySessionsFreed } from '../spawnQueue.js';
import { assertGitDirIntact, parseWorktreesPorcelain } from './state.js';
import { assertNotReparsePoint, assertSafeWorktreePath } from './cleanupSafety.js';
import { pruneReparsePointsUnder } from './reparsePoints.js';
import { archiveUncommittedWorktreeChanges } from './discardArchive.js';
import { clearStaleInitializingLock } from './staleInitLock.js';

const CLEANUP_GIT_TIMEOUT_MS = 15_000;

export type WorktreeCleanupDeps = {
  projectGit: typeof projectGit;
  proxyKillSessionsByCwd: typeof proxyKillSessionsByCwd;
  notifySessionsFreed: typeof notifySessionsFreed;
  archiveUncommitted?: typeof archiveUncommittedWorktreeChanges;
  // Optional so hand-built test deps keep compiling.
  notifyDiskSpaceFreed?: typeof notifyDiskSpaceFreed;
};
const defaultDeps: WorktreeCleanupDeps = {
  projectGit, proxyKillSessionsByCwd, notifySessionsFreed, notifyDiskSpaceFreed,
};

export type WorktreeCleanupOptions = {
  // The caller already archived the uncommitted changes (the boot sweep does,
  // before deciding to reclaim), so don't take a second, identical archive.
  skipArchive?: boolean;
  // Remove the worktree but KEEP the `lattice/*` branch when it has commits
  // not in the project HEAD (`rev-list --count HEAD..<branch>` > 0) — that
  // branch is then the only copy of the work. Task delete sets this; a
  // post-merge finalize does not (its branch is merged by construction). An
  // undeterminable count keeps the branch (fail safe). The kept branch is
  // reported through `onBranchKept`, and cleanup still returns `true`.
  keepBranchIfUnmerged?: boolean;
  onBranchKept?: (info: KeptBranchInfo) => void;
};

export type KeptBranchInfo = {
  name: string;
  // null when the count could not be determined (the branch is kept anyway).
  unmergedCommits: number | null;
};

function normalizePath(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.lstat(target);
    return true;
  } catch (err) {
    // Permission failures are unknown state, never evidence of absence.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}

// `LATTICE_BRANCH_RE` (imported above from projectGit's policy) is the
// branch-delete guard projectGit would throw on for anything else — we
// pre-check with it here so a stray non-`lattice/` branch name just gets
// skipped+logged rather than thrown.

export async function cleanupWorktreeForTask(
  repoRoot: string,
  worktreePath: string,
  branchName: string,
  deps: WorktreeCleanupDeps = defaultDeps,
  opts: WorktreeCleanupOptions = {},
): Promise<boolean> {
  // Sanity bound + .git-intact check before any git work. (projectGit also
  // asserts .git, but the explicit call here gives a clearer trace.)
  assertSafeWorktreePath(repoRoot, worktreePath);
  await assertGitDirIntact(repoRoot);

  const git = (args: string[]) => deps.projectGit(repoRoot, args, {
    timeoutMs: CLEANUP_GIT_TIMEOUT_MS,
  });
  const readWorktrees = async () => {
    const result = await git(['worktree', 'list', '--porcelain', '-z']);
    const entries = parseWorktreesPorcelain(result.stdout);
    if (result.code !== 0 || entries.length === 0) {
      console.warn(`[worktree] cleanup deferred: cannot read worktree registrations in ${repoRoot}: ` +
        (result.stderr.trim() || `exit ${result.code}, ${entries.length} entries`));
      return null;
    }
    return entries;
  };
  let before = await readWorktrees();
  if (!before) return false;
  // An interrupted `git worktree add` leaves git's own "initializing" lock;
  // honouring it as a user lock stranded the half-written checkout for good.
  // Such a checkout never finished, so no agent ever ran in it: skip the
  // archive (every file reads as "untracked" — it would copy the whole tree).
  const initLocked = before.find((wt) => normalizePath(wt.path) === normalizePath(worktreePath));
  const interruptedAdd = !!initLocked && await clearStaleInitializingLock(repoRoot, initLocked);
  if (interruptedAdd) {
    before = await readWorktrees();
    if (!before) return false;
  }
  const registration = before.find((wt) => normalizePath(wt.path) === normalizePath(worktreePath));
  const nested = before.find((wt) => normalizePath(wt.path).startsWith(normalizePath(worktreePath) + path.sep));
  if (nested) {
    console.warn(`[worktree] cleanup deferred for ${worktreePath}: contains another registered worktree at ${nested.path}.`);
    return false;
  }
  const expectedBranch = branchName ? `refs/heads/${branchName}` : undefined;
  if (registration?.locked || (registration && registration.branch !== expectedBranch)) {
    console.warn(`[worktree] cleanup deferred for ${worktreePath}: ` +
      'the worktree is locked or its branch has changed; preserving the checkout and branch.');
    return false;
  }
  if (!registration && await pathExists(worktreePath)) {
    console.warn(`[worktree] cleanup deferred for ${worktreePath}: ` +
      'directory exists without a matching Git registration; preserving it for inspection.');
    return false;
  }

  if (registration) {
    // Validate the physical target before touching terminals or links inside it.
    await assertNotReparsePoint(worktreePath);

    // Kill any terminal sessions running inside the worktree first. On
    // Windows a process whose cwd is inside a directory holds a lock that
    // prevents deletion — killing the PTY releases it before git removes.
    await deps.proxyKillSessionsByCwd(worktreePath);
    // Killing the worktree's ptys freed slots — let the spawn queue reuse them.
    deps.notifySessionsFreed();
    // Brief pause so the OS has time to release handles after PTY exit.
    await new Promise<void>((r) => setTimeout(r, 300));

    // A user may move, lock or repurpose a checkout while PTY shutdown awaits.
    const current = await readWorktrees();
    const same = current?.find((wt) => normalizePath(wt.path) === normalizePath(worktreePath));
    if (!same || same.locked || same.branch !== registration.branch ||
        current?.some((wt) => normalizePath(wt.path).startsWith(normalizePath(worktreePath) + path.sep))) {
      console.warn(`[worktree] cleanup deferred for ${worktreePath}: registrations changed while releasing terminals.`);
      return false;
    }
    await assertNotReparsePoint(worktreePath);

    // `worktree remove --force` silently drops uncommitted edits. Every caller
    // (post-merge finalize, task delete, a failed run's teardown, …) gets the
    // same keep-for-the-user archive a fresh Run's reconcile takes — AFTER the
    // PTY kill, so the agent can't still be writing. A normal finalize leaves
    // only Lattice-managed files behind, which aren't archived ('clean').
    // If the archive fails, keep the checkout rather than lose the work.
    if (!opts.skipArchive && !interruptedAdd) {
      const archive = deps.archiveUncommitted ?? archiveUncommittedWorktreeChanges;
      const archived = await archive(repoRoot, worktreePath, branchName);
      if (archived.status === 'failed') {
        console.error(
          `[worktree] cleanup deferred for ${worktreePath}: could not archive its uncommitted ` +
            `changes (${archived.error}); preserving the checkout and branch.`,
        );
        return false;
      }
      if (archived.status === 'archived') {
        console.warn(`[worktree] archived ${archived.files} uncommitted change(s) from ${worktreePath} to ${archived.dir}`);
      }
    }

    // Break any reparse-point loops inside the worktree (npm `file:` self-dep
    // junctions, etc.) before handing it to git — otherwise `git worktree
    // remove` on Windows fails with "failed to delete ...: Function not
    // implemented" and orphans the directory. A failure here must not abort
    // teardown; the worst case is the git call below failing as it did before.
    try {
      const pruned = await pruneReparsePointsUnder(worktreePath);
      if (pruned > 0) {
        console.log(
          `[worktree] cleared ${pruned} reparse point(s) inside ${worktreePath} before removal.`,
        );
      }
    } catch (err) {
      console.warn(`[worktree] pruneReparsePointsUnder(${worktreePath}) failed (continuing):`, err);
    }

    const rm = await git(['worktree', 'remove', '--force', worktreePath]);
    let leftAsResidue = false;
    if (rm.code !== 0) {
      const detail = rm.stderr.trim() || rm.stdout.trim() || '(no output)';
      // On Windows git stops at the first locked file ("Invalid argument") but
      // has ALREADY dropped the registration and `.git` — so no sweep that
      // walks registrations will ever see this checkout (or its branch) again.
      const afterRm = await readWorktrees();
      const stillRegistered = !afterRm ||
        afterRm.some((wt) => normalizePath(wt.path) === normalizePath(worktreePath));
      if (stillRegistered) {
        // Couldn't remove and git still tracks it — leave the directory for the
        // boot-time orphan sweep to retry. Never escalate to a raw fs.rm here.
        console.warn(
          `[worktree] 'git worktree remove --force ${worktreePath}' exit ${rm.code}: ${detail} — ` +
            'leaving the checkout in place; the boot-time orphan sweep will retry it.',
        );
        // Keep the branch and registration together for a later retry. Attempting
        // branch -D here only adds "branch used by worktree" to the actual error.
        return false;
      }
      // Registration gone: what is left is inert residue (no `.git`, no
      // registration), which the residue sweep (recovery/worktreeResidueSweep.ts)
      // reclaims once it unlocks. The branch step below proceeds as normal —
      // keeping it here would leak it forever.
      console.warn(
        `[worktree] 'git worktree remove --force ${worktreePath}' exit ${rm.code}: ${detail} — ` +
          'git dropped the registration; the remaining files are left for the residue sweep.',
      );
      leftAsResidue = true;
    }
    // The checkout's disk is back (most of it, for residue): runs deferred for
    // space retry now instead of sitting out their backoff.
    deps.notifyDiskSpaceFreed?.();
    if (leftAsResidue) return deleteTaskBranch(git, readWorktrees, branchName, opts);
  }
  if (await pathExists(worktreePath)) {
    // git reported success but the dir is somehow still there. Don't fs.rm —
    // preserve it and the branch; an unregistered directory needs inspection.
    console.warn(
      `[worktree] 'git worktree remove' succeeded but ${worktreePath} still exists; ` +
        `preserving it and the branch for inspection.`,
    );
    return false;
  }

  // Exact worktree removal already removes its registration, even when its
  // folder was manually deleted. Global prune could discard an unrelated
  // temporarily offline checkout's registration, so it does not belong here.
  return deleteTaskBranch(git, readWorktrees, branchName, opts);
}

// Delete the task branch — but only `lattice/*` ones (projectGit enforces
// this too; pre-checking just turns a stray name into a skip+log instead
// of a throw that the caller would have to absorb).
async function deleteTaskBranch(
  git: (args: string[]) => ReturnType<typeof projectGit>,
  readWorktrees: () => Promise<ReturnType<typeof parseWorktreesPorcelain> | null>,
  branchName: string,
  opts: WorktreeCleanupOptions,
): Promise<boolean> {
  if (LATTICE_BRANCH_RE.test(branchName)) {
    const after = await readWorktrees();
    if (!after) return false;
    const owner = after.find((wt) => wt.branch === `refs/heads/${branchName}`);
    if (owner) {
      console.warn(`[worktree] keeping branch ${branchName}: Git still associates it with ${owner.path}; ` +
        'cleanup deferred until that worktree is removed or repaired.');
      return false;
    }
    const ref = await git(['rev-parse', '--verify', '--quiet', `refs/heads/${branchName}`]);
    if (ref.code === 1) return true; // Already deleted by an earlier cleanup.
    if (ref.code !== 0) {
      console.warn(`[worktree] cleanup deferred: cannot inspect branch ${branchName}: ${ref.stderr.trim()}`);
      return false;
    }
    if (opts.keepBranchIfUnmerged) {
      const unmerged = await git(['rev-list', '--count', `HEAD..refs/heads/${branchName}`]);
      const parsed = unmerged.code === 0 ? parseInt(unmerged.stdout.trim(), 10) : NaN;
      const count = Number.isFinite(parsed) ? parsed : null;
      if (count === null || count > 0) {
        console.warn(
          `[worktree] keeping branch ${branchName}: ` +
            (count === null
              ? `unmerged-commit count failed (exit ${unmerged.code}): ${unmerged.stderr.trim()}`
              : `${count} unmerged commit(s)`) +
            ' — merge it or delete it by hand if the work is no longer wanted.',
        );
        opts.onBranchKept?.({ name: branchName, unmergedCommits: count });
        return true;
      }
    }
    const del = await git(['branch', '-D', branchName]);
    if (del.code !== 0) {
      console.warn(
        `[worktree] 'git branch -D ${branchName}' exit ${del.code}: ` +
          `${del.stderr.trim() || del.stdout.trim() || '(no output)'}`,
      );
      return false;
    }
  } else if (branchName) {
    console.warn(
      `[worktree] not deleting branch "${branchName}" — not a lattice/* branch.`,
    );
  }

  return true;
}
