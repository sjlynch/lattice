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

import { projectGit } from './projectGit.js';
import { proxyKillSessionsByCwd } from '../terminalProxy.js';
import { assertGitDirIntact, worktreeExists } from './state.js';
import { assertSafeWorktreePath } from './cleanupSafety.js';
import { pruneReparsePointsUnder } from './reparsePoints.js';

const CLEANUP_GIT_TIMEOUT_MS = 15_000;

// Branches Lattice may delete in the project repo. Mirrors projectGit's
// branch-delete guard (which would throw on anything else) — we pre-check
// here so a stray non-`lattice/` branch name just gets skipped+logged
// rather than thrown.
const LATTICE_BRANCH_RE = /^lattice\//;

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
