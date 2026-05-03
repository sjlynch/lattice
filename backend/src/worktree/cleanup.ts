// Tear down a worktree: kill any terminals running inside it (so Windows
// releases file locks), then remove the worktree, branch, and stale dir.
//
// Every git invocation here has a hard timeout — a hung process holding
// the worktree dir open on Windows would otherwise wedge cleanup forever
// and stall the run worker (which awaits cleanup mid-iteration).

import fs from 'node:fs/promises';
import { exec } from './exec.js';
import { proxyKillSessionsByCwd } from '../terminalProxy.js';

const CLEANUP_GIT_TIMEOUT_MS = 15_000;

export async function cleanupWorktreeForTask(
  repoRoot: string,
  worktreePath: string,
  branchName: string,
): Promise<void> {
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
