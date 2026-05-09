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
  try {
    await fs.rm(worktreePath, { recursive: true, force: true });
  } catch {
    /* already gone, or still locked — tolerate */
  }
}
