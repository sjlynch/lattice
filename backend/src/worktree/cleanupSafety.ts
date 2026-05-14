// Path-safety bounds + reparse-point guard used wherever Lattice is about
// to delete or remove a worktree directory. Pulled out of cleanup.ts so
// the rules live in one place and the cleanup pipeline reads as
// orchestration rather than safety theatre.
//
// Every prior `.git`-deletion incident on this project traced back to a
// recursive filesystem delete (directly via `fs.rm`, or indirectly via a
// lost `git stash --include-untracked`) reaching something it shouldn't.
// These helpers are the inner ring of defence that makes that structurally
// impossible: bound *where* we may delete (must be under a Lattice-managed
// worktrees dir), and refuse if the path is a symlink/junction whose real
// target is somewhere else.
//
// See backend/src/worktree/CLAUDE.md for the full layered-defence story.

import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { isPathStrictlyInside } from './paths.js';
import { projectHash } from '../projectPath.js';

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
    isPathStrictlyInside(homeBase, resolved) ||
    isPathStrictlyInside(legacyBase, resolved)
  );
}

// Sanity bound before any git-worktree teardown. `git worktree remove`
// already refuses the main worktree, so this is belt-and-suspenders: it
// catches an obviously-wrong worktreePath (empty string, the repo root
// itself, a path outside every managed location) before we hand it to git.
export function assertSafeWorktreePath(repoRoot: string, worktreePath: string): void {
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
// (the stray-dir cleanup in reconcile.ts). The lexical
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
