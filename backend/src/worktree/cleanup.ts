// Tear down a worktree: kill any terminals running inside it (so Windows
// releases file locks), then remove the worktree, branch, and stale dir.
//
// Every git invocation here has a hard timeout — a hung process holding
// the worktree dir open on Windows would otherwise wedge cleanup forever
// and stall the run worker (which awaits cleanup mid-iteration).

import path from 'node:path';
import fs from 'node:fs/promises';
import { exec } from './exec.js';
import { proxyKillSessionsByCwd } from '../terminalProxy.js';
import { assertGitDirIntact } from './state.js';

const CLEANUP_GIT_TIMEOUT_MS = 15_000;

// Throws if worktreePath is not a proper subdirectory of
// <repoRoot>/.lattice/worktrees/. This is the last line of defence before
// `fs.rm --recursive --force`: git worktree remove cannot remove the main
// worktree, but fs.rm has no such protection — a bad worktreePath (the repo
// root itself, an empty string, etc.) would silently delete the entire repo.
function assertSafeWorktreePath(repoRoot: string, worktreePath: string): void {
  const resolved = path.resolve(worktreePath);
  const base = path.resolve(path.join(repoRoot, '.lattice', 'worktrees'));
  // Must be strictly inside `base` — not base itself, not a sibling path
  // that shares a prefix (e.g. `.lattice/worktrees-extra`).
  if (!resolved.startsWith(base + path.sep)) {
    throw new Error(
      `[worktree] safety: refusing recursive delete of "${resolved}" — ` +
        `it is not under "${base}". Check that task.worktreePath is correct.`,
    );
  }
}

// Reparse-point guard. The lexical assertSafeWorktreePath check is purely
// string-based — `path.resolve(...).startsWith(safeBase + path.sep)` does
// not follow symlinks or Windows junctions. If `.lattice/worktrees/foo`
// were ever a junction pointing at the repo root (or its `.git`), the
// lexical check would still pass and `fs.rm({recursive: true, force: true})`
// would walk through the junction and delete the target. Lattice itself
// never creates junctions, but a user can, and a corrupted git operation
// can leave one behind.
//
// We refuse if the path is a symlink (lstat tells us directly) OR if
// realpath resolves to a different location (catches junctions / mount
// points / 8.3 short-name aliases that lstat doesn't flag as symlinks).
// Caller is expected to swallow ENOENT — the absent case is not unsafe.
export async function assertNotReparsePoint(target: string): Promise<void> {
  let stat;
  try {
    stat = await fs.lstat(target);
  } catch (err) {
    // Caller decides what to do with ENOENT; a missing path is safe.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
  if (stat.isSymbolicLink()) {
    throw new Error(
      `[worktree] safety: refusing fs.rm on symbolic link: ${target}. ` +
        `Investigate manually — Lattice never creates symlinks.`,
    );
  }
  // Junctions on Windows often report isDirectory() && !isSymbolicLink(),
  // so lstat alone isn't enough. realpath resolves the reparse and gives
  // us the underlying path; if it differs from target after normalization,
  // something is redirecting and we don't want to follow it with fs.rm.
  let real;
  try {
    real = await fs.realpath(target);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
  const normReal = path.resolve(real);
  const normTarget = path.resolve(target);
  // Case-insensitive compare on Windows where the FS is case-insensitive
  // but case-preserving — realpath may return e.g. `C:\Development\` while
  // the input was `C:\development\`. Don't refuse just on case.
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
  // Guard against catastrophic deletion if worktreePath is somehow the main
  // repo root or any path outside the expected worktrees directory.
  assertSafeWorktreePath(repoRoot, worktreePath);

  // Bail if main .git has been deleted. `git worktree remove` invoked in a
  // repoRoot without a gitdir can walk up the file system and find a
  // different repo's .git, which is exactly how prior incidents started.
  await assertGitDirIntact(repoRoot);

  // Kill any terminal sessions running inside the worktree first.
  // On Windows a process whose cwd is inside a directory holds a lock that
  // prevents deletion — killing the PTY releases it before git tries to remove.
  await proxyKillSessionsByCwd(worktreePath);
  // Brief pause so the OS has time to release handles after PTY exit.
  await new Promise<void>((r) => setTimeout(r, 300));

  await exec('git', ['worktree', 'remove', '--force', worktreePath], repoRoot, { timeoutMs: CLEANUP_GIT_TIMEOUT_MS });
  await exec('git', ['branch', '-D', branchName], repoRoot, { timeoutMs: CLEANUP_GIT_TIMEOUT_MS });
  // Best-effort prune of stale entries
  await exec('git', ['worktree', 'prune'], repoRoot, { timeoutMs: CLEANUP_GIT_TIMEOUT_MS });

  // Forcibly remove the directory with Node.js as a fallback for cases where
  // git couldn't delete it (e.g. a process had the directory as its cwd).
  // Reparse-point guard: refuse to fs.rm a symlink or junction, since
  // recursive delete would walk through it and destroy the target.
  try {
    await assertNotReparsePoint(worktreePath);
    await fs.rm(worktreePath, { recursive: true, force: true });
  } catch (err) {
    // Reparse-point refusal logs and continues — the worktree is left in
    // place for manual investigation. Other errors (already gone, still
    // locked) are tolerated as before.
    if (
      err instanceof Error &&
      err.message.includes('[worktree] safety: refusing')
    ) {
      console.error(err.message);
    }
  }
}
