import { projectGit } from '../projectGit.js';
import {
  abortWorktreeMerge,
  assertGitDirIntact,
  isMidMerge,
  worktreeExists,
} from '../state.js';
import type { MergeOutcome } from '../merge.js';

export type WorktreeMergePreflightResult =
  | { ok: true; mainHeadSha: string; recoveredFromOrphanMerge: boolean }
  | { ok: false; outcome: MergeOutcome };

export async function preflightWorktreeMerge(
  repoRoot: string,
  branchName: string,
  worktreePath: string,
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

  if (!(await worktreeExists(worktreePath))) {
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
