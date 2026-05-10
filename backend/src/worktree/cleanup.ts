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

import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { projectGit } from './projectGit.js';
import { proxyKillSessionsByCwd } from '../terminalProxy.js';
import { assertGitDirIntact, worktreeExists } from './state.js';
import { projectHash } from '../projectPath.js';

const CLEANUP_GIT_TIMEOUT_MS = 15_000;

// Branches Lattice may delete in the project repo. Mirrors projectGit's
// branch-delete guard (which would throw on anything else) — we pre-check
// here so a stray non-`lattice/` branch name just gets skipped+logged
// rather than thrown.
const LATTICE_BRANCH_RE = /^lattice\//;

// True if `worktreePath` is inside a directory Lattice manages worktrees
// in for `repoRoot`: the current home location
// (`~/.lattice/worktrees/<projectHash>/`) OR the legacy in-project location
// (`<repo>/.lattice/worktrees/`) used before 2026-05-10. Used by the boot
// sweep to decide which `git worktree list` entries are ours to reclaim,
// and by assertSafeWorktreePath as a sanity bound.
export function isUnderManagedWorktreesDir(
  worktreePath: string,
  repoRoot: string,
): boolean {
  const resolved = path.resolve(worktreePath);
  const homeBase = path.resolve(
    path.join(os.homedir(), '.lattice', 'worktrees', projectHash(repoRoot)),
  );
  const legacyBase = path.resolve(path.join(repoRoot, '.lattice', 'worktrees'));
  return (
    resolved.startsWith(homeBase + path.sep) ||
    resolved.startsWith(legacyBase + path.sep)
  );
}

// Sanity bound before any git-worktree teardown. `git worktree remove`
// already refuses the main worktree, so this is belt-and-suspenders: it
// catches an obviously-wrong worktreePath (empty string, the repo root
// itself, a path outside every managed location) before we hand it to git.
function assertSafeWorktreePath(repoRoot: string, worktreePath: string): void {
  if (!worktreePath || !worktreePath.trim()) {
    throw new Error('[worktree] safety: refusing teardown of an empty worktree path.');
  }
  const resolved = path.resolve(worktreePath);
  if (resolved === path.resolve(repoRoot)) {
    throw new Error(
      `[worktree] safety: refusing teardown of "${resolved}" — that is the repo root.`,
    );
  }
  if (!isUnderManagedWorktreesDir(worktreePath, repoRoot)) {
    throw new Error(
      `[worktree] safety: refusing teardown of "${resolved}" — it is not under ` +
        `a Lattice-managed worktrees directory for ${repoRoot}. ` +
        `Check that task.worktreePath is correct.`,
    );
  }
}

// Reparse-point guard. Retained for the few fs.rm sites that still exist
// (the stray-dir cleanup in setup.ts's reconcile path). The lexical
// startsWith check is purely string-based — it does not follow symlinks or
// Windows junctions. If a path were ever a junction pointing at the repo
// root (or its `.git`), the lexical check would still pass and
// `fs.rm({recursive: true, force: true})` would walk through the junction
// and delete the target. We refuse if the path is a symlink (lstat tells
// us directly) OR if realpath resolves to a different location (catches
// junctions / mount points / 8.3 short-name aliases lstat doesn't flag).
// Caller is expected to swallow ENOENT — the absent case is not unsafe.
export async function assertNotReparsePoint(target: string): Promise<void> {
  let stat;
  try {
    stat = await fs.lstat(target);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
  if (stat.isSymbolicLink()) {
    throw new Error(
      `[worktree] safety: refusing fs.rm on symbolic link: ${target}. ` +
        `Investigate manually — Lattice never creates symlinks.`,
    );
  }
  let real;
  try {
    real = await fs.realpath(target);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
  const normReal = path.resolve(real);
  const normTarget = path.resolve(target);
  const same =
    process.platform === 'win32'
      ? normReal.toLowerCase() === normTarget.toLowerCase()
      : normReal === normTarget;
  if (!same) {
    throw new Error(
      `[worktree] safety: refusing fs.rm on reparse point: ${target} → ${real}. ` +
        `The path resolves to a different location than expected.`,
    );
  }
}

export async function cleanupWorktreeForTask(
  repoRoot: string,
  worktreePath: string,
  branchName: string,
): Promise<void> {
  // Sanity bound + .git-intact check before any git work. (projectGit also
  // asserts .git, but the explicit call here gives a clearer trace.)
  assertSafeWorktreePath(repoRoot, worktreePath);
  await assertGitDirIntact(repoRoot);

  // Kill any terminal sessions running inside the worktree first. On
  // Windows a process whose cwd is inside a directory holds a lock that
  // prevents deletion — killing the PTY releases it before git removes.
  await proxyKillSessionsByCwd(worktreePath);
  // Brief pause so the OS has time to release handles after PTY exit.
  await new Promise<void>((r) => setTimeout(r, 300));

  const rm = await projectGit(
    repoRoot,
    ['worktree', 'remove', '--force', worktreePath],
    { timeoutMs: CLEANUP_GIT_TIMEOUT_MS },
  );
  if (rm.code !== 0) {
    // Couldn't remove — leave the directory for the boot sweep to retry.
    // It's an inert orphan; never escalate to a raw fs.rm here.
    console.warn(
      `[worktree] 'git worktree remove --force ${worktreePath}' exit ${rm.code}: ` +
        `${rm.stderr.trim() || rm.stdout.trim() || '(no output)'} — leaving the ` +
        `directory in place; the boot-time sweep will retry it.`,
    );
  } else if (await worktreeExists(worktreePath)) {
    // git reported success but the dir is somehow still there. Don't fs.rm —
    // log it; the sweep will pick it up (git no longer tracks it, so the
    // sweep's `git worktree prune` plus a re-`remove` finishes the job, or
    // it just stays as a harmless empty dir under ~/.lattice/worktrees/).
    console.warn(
      `[worktree] 'git worktree remove' succeeded but ${worktreePath} still exists; ` +
        `leaving it for the boot-time sweep.`,
    );
  }

  // Delete the task branch — but only `lattice/*` ones (projectGit enforces
  // this too; pre-checking just turns a stray name into a skip+log instead
  // of a throw that the caller would have to absorb).
  if (LATTICE_BRANCH_RE.test(branchName)) {
    const del = await projectGit(repoRoot, ['branch', '-D', branchName], {
      timeoutMs: CLEANUP_GIT_TIMEOUT_MS,
    });
    if (del.code !== 0) {
      console.warn(
        `[worktree] 'git branch -D ${branchName}' exit ${del.code}: ` +
          `${del.stderr.trim() || del.stdout.trim() || '(no output)'}`,
      );
    }
  } else if (branchName) {
    console.warn(
      `[worktree] not deleting branch "${branchName}" — not a lattice/* branch.`,
    );
  }

  // Best-effort prune of stale registrations.
  await projectGit(repoRoot, ['worktree', 'prune'], { timeoutMs: CLEANUP_GIT_TIMEOUT_MS });
}
