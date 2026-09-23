import path from 'node:path';
import { projectGit } from '../projectGit.js';
import { reserveWorktreeDiskSpace, type DiskReservation } from '../diskSpace.js';
import {
  abortWorktreeMerge,
  assertGitDirIntact,
  isMidMerge,
  worktreeExists,
} from '../state.js';
import { assertSafeWorktreePath } from '../cleanupSafety.js';
import { installStopHook, writeWorktreeExclude } from '../stopHook.js';
import { LATTICE_EXCLUDE_PATTERNS } from '../managedFiles.js';
import type { MergeOutcome } from '../merge.js';

export type WorktreeMergePreflightResult =
  | { ok: true; mainHeadSha: string; recoveredFromOrphanMerge: boolean }
  | { ok: false; outcome: MergeOutcome };

// What a re-created worktree needs so its resolver Claude can still report
// back: the task id + backend origin for the Stop hook.
export type WorktreeStopHookSpec = { taskId: string; backendOrigin: string };

// The project checkout must be ON A BRANCH. `git merge --ff-only` merges into
// whatever HEAD is: on a detached HEAD the branch tip lands only on that
// detached HEAD, `main` never moves, and the `lattice/*` branch is then
// deleted by cleanup — leaving the merged commits reachable from nothing but
// the reflog. `symbolic-ref -q HEAD` exits non-zero exactly when HEAD is
// detached (the read form is on the projectGit whitelist).
export async function assertMainOnBranch(
  repoRoot: string,
): Promise<{ ok: true } | { ok: false; outcome: MergeOutcome }> {
  const ref = await projectGit(repoRoot, ['symbolic-ref', '-q', 'HEAD']);
  if (ref.code === 0 && ref.stdout.trim()) return { ok: true };
  return {
    ok: false,
    outcome: {
      status: 'error',
      message:
        'main checkout is on a detached HEAD — check out a branch before merging',
    },
  };
}

// A `ready_to_merge` task whose worktree DIRECTORY was deleted by hand (an
// Explorer delete, a disk clean-up) but whose branch still exists used to
// fail preflight forever ("Worktree directory not found"). The branch holds
// the work; the checkout is disposable — re-create it: drop the stale
// registration (`worktree remove --force` exits 0 on a missing dir), add the
// worktree back on the existing branch, and re-install the Stop hook so the
// resolver's `/complete` still lands. Any failure falls through to the
// existing error. Only the branch-exists case is recovered: no branch means
// nothing to check out.
async function tryRecreateMissingWorktree(
  repoRoot: string,
  branchName: string,
  worktreePath: string,
  stopHook: WorktreeStopHookSpec | undefined,
): Promise<boolean> {
  try {
    assertSafeWorktreePath(repoRoot, worktreePath);
  } catch (err) {
    console.warn(`[merge] not re-creating ${worktreePath}: ${(err as Error).message}`);
    return false;
  }
  const ref = await projectGit(repoRoot, ['rev-parse', '--verify', '--quiet', `refs/heads/${branchName}`]);
  if (ref.code !== 0) return false;
  // Same free-space rule as a fresh run: a re-created checkout is just as big.
  let disk: DiskReservation;
  try {
    disk = await reserveWorktreeDiskSpace(repoRoot, path.dirname(worktreePath));
  } catch (err) {
    console.warn(`[merge] not re-creating ${worktreePath}: ${(err as Error).message}`);
    return false;
  }
  // Best-effort: a registration that still points at the missing dir blocks
  // `worktree add`; when there is none this fails harmlessly.
  let add: Awaited<ReturnType<typeof projectGit>>;
  try {
    await projectGit(repoRoot, ['worktree', 'remove', '--force', worktreePath]);
    add = await projectGit(repoRoot, ['worktree', 'add', worktreePath, branchName]);
  } finally {
    disk.release();
  }
  if (add.code !== 0) {
    console.warn(
      `[merge] re-creating missing worktree ${worktreePath} on ${branchName} failed ` +
        `(exit ${add.code}): ${add.stderr.trim() || add.stdout.trim()}`,
    );
    return false;
  }
  try {
    await writeWorktreeExclude(worktreePath, [...LATTICE_EXCLUDE_PATTERNS]);
    if (stopHook) await installStopHook(worktreePath, stopHook.taskId, stopHook.backendOrigin);
  } catch (err) {
    console.warn(`[merge] re-created ${worktreePath} but could not install its hooks:`, err);
  }
  console.warn(
    `[merge] worktree directory ${worktreePath} was missing — re-created it from branch ${branchName}`,
  );
  return true;
}

export async function preflightWorktreeMerge(
  repoRoot: string,
  branchName: string,
  worktreePath: string,
  stopHook?: WorktreeStopHookSpec,
): Promise<WorktreeMergePreflightResult> {
  // Bail before any git command runs if the main repo's .git has gone
  // missing since the merge was queued. Otherwise git invoked in repoRoot
  // walks up the dir tree looking for a gitdir and may latch onto an
  // unrelated repo's .git, with destructive consequences.
  try {
    await assertGitDirIntact(repoRoot);
  } catch (err) {
    return {
      ok: false,
      outcome: { status: 'error', message: (err as Error).message },
    };
  }

  const isGit = await projectGit(repoRoot, ['rev-parse', '--show-toplevel']);
  if (isGit.code !== 0) {
    return {
      ok: false,
      outcome: {
        status: 'error',
        message: `Not a git repository: ${repoRoot}`,
      },
    };
  }

  const onBranch = await assertMainOnBranch(repoRoot);
  if (!onBranch.ok) return onBranch;

  if (await isMidMerge(repoRoot)) {
    return {
      ok: false,
      outcome: {
        status: 'error',
        message:
          'Main repo is already in a merge state (MERGE_HEAD exists). ' +
          'Resolve or `git merge --abort` first.',
      },
    };
  }

  if (
    !(await worktreeExists(worktreePath)) &&
    !(await tryRecreateMissingWorktree(repoRoot, branchName, worktreePath, stopHook))
  ) {
    return {
      ok: false,
      outcome: {
        status: 'error',
        message: `Worktree directory not found at ${worktreePath}.`,
      },
    };
  }

  // Orphan-mid-merge auto-recovery. Reaching here means the caller has
  // asked for a fresh merge attempt (the conflict-resolver paths take a
  // different branch via `handleFlaggedConflictTask` / the routes' early
  // mid-merge checks). A worktree-side MERGE_HEAD with no live resolver
  // is residue from a prior crashed attempt — backend killed mid-merge by
  // `tsc -w`, OS signal, or a resolver Claude that curled `/merge-aborted`
  // without actually running `git merge --abort` first. The branch's own
  // commits are preserved by `git merge --abort`; only the half-done merge
  // is discarded. Pre-fix this was an error that blocked the user with no
  // UI recovery action — see hooks.ts `/merge-aborted` for the upstream
  // hardening that now prevents the false-clear case.
  let recoveredFromOrphanMerge = false;
  if (await isMidMerge(worktreePath)) {
    console.warn(
      `[merge] orphan MERGE_HEAD detected at ${worktreePath} — auto-aborting before retry`,
    );
    const aborted = await abortWorktreeMerge(worktreePath);
    if (!aborted.ok) {
      return {
        ok: false,
        outcome: {
          status: 'error',
          message:
            `Worktree at ${worktreePath} was in a stuck merge state and ` +
            `auto-abort failed: ${aborted.message}. Run ` +
            `\`git -C "${worktreePath}" merge --abort\` manually.`,
        },
      };
    }
    recoveredFromOrphanMerge = true;
  }

  const mainHeadSha = (
    await projectGit(repoRoot, ['rev-parse', 'HEAD'])
  ).stdout.trim();
  if (!mainHeadSha) {
    return {
      ok: false,
      outcome: { status: 'error', message: 'Could not read main HEAD SHA.' },
    };
  }

  return { ok: true, mainHeadSha, recoveredFromOrphanMerge };
}
