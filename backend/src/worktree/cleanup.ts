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
// is inert — and the boot-time sweep (`sweepOrphanedWorktrees` in
// recovery.ts) retries it later. Worktrees now live outside the project
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
import { notifySessionsFreed } from '../spawnQueue.js';
import { assertGitDirIntact, parseWorktreesPorcelain } from './state.js';
import { assertNotReparsePoint, assertSafeWorktreePath } from './cleanupSafety.js';
import { pruneReparsePointsUnder } from './reparsePoints.js';

const CLEANUP_GIT_TIMEOUT_MS = 15_000;

export type WorktreeCleanupDeps = {
  projectGit: typeof projectGit;
  proxyKillSessionsByCwd: typeof proxyKillSessionsByCwd;
  notifySessionsFreed: typeof notifySessionsFreed;
};
const defaultDeps: WorktreeCleanupDeps = {
  projectGit, proxyKillSessionsByCwd, notifySessionsFreed,
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
  const before = await readWorktrees();
  if (!before) return false;
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
    if (rm.code !== 0) {
      // Couldn't remove — leave the directory for the boot sweep to retry.
      // It's an inert orphan; never escalate to a raw fs.rm here.
      console.warn(
        `[worktree] 'git worktree remove --force ${worktreePath}' exit ${rm.code}: ` +
          `${rm.stderr.trim() || rm.stdout.trim() || '(no output)'} — leaving the ` +
          `directory in place; the boot-time sweep will retry it.`,
      );
      // Keep the branch and registration together for a later retry. Attempting
      // branch -D here only adds "branch used by worktree" to the actual error.
      return false;
    }
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

  // Delete the task branch — but only `lattice/*` ones (projectGit enforces
  // this too; pre-checking just turns a stray name into a skip+log instead
  // of a throw that the caller would have to absorb).
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
