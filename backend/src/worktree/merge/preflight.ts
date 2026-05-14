import { projectGit } from '../projectGit.js';
import {
  assertGitDirIntact,
  isMidMerge,
  worktreeExists,
} from '../state.js';
import type { MergeOutcome } from '../merge.js';

export type WorktreeMergePreflightResult =
  | { ok: true; mainHeadSha: string }
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

  if (await isMidMerge(worktreePath)) {
    return {
      ok: false,
      outcome: {
        status: 'error',
        message:
          `Worktree at ${worktreePath} is already in a merge state — a ` +
          `previous resolver may still be running. Inspect, or run ` +
          `\`git -C "${worktreePath}" merge --abort\` to retry from scratch.`,
      },
    };
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

  return { ok: true, mainHeadSha };
}
