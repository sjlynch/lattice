import path from 'node:path';
import { projectGit } from './projectGit.js';
import {
  MAX_PATH_RETRY_SUFFIXES,
  reconcileStaleState,
} from './reconcile.js';
import {
  canonicalWorktreePath,
  type WorktreeCandidatePlan,
  type WorktreeSetupCandidate,
} from './setupCandidates.js';

export type AddedWorktreeCandidate = WorktreeSetupCandidate;

export async function addWorktreeWithRetries(
  repoRoot: string,
  plan: WorktreeCandidatePlan,
  taskTitle: string,
): Promise<AddedWorktreeCandidate> {
  // Try the canonical path first; if reconciliation can't free it (Windows
  // file lock from an Explorer window, editor, etc.), fall through to a
  // suffixed path so the user isn't blocked. The branch name follows the
  // same retry suffix so `git worktree add -b` doesn't collide either.
  for (const candidate of plan.candidates) {
    const reconciled = await reconcileStaleState(
      repoRoot,
      candidate.candidateBranch,
      candidate.candidatePath,
    );
    if (!reconciled) {
      // Path or branch couldn't be cleaned. Try the next suffix.
      console.warn(
        `[worktree] could not reconcile ${candidate.candidatePath}; trying next suffix`,
      );
      continue;
    }

    const wt = await projectGit(
      repoRoot,
      ['worktree', 'add', candidate.candidatePath, '-b', candidate.candidateBranch],
    );
    if (wt.code !== 0) {
      // `git worktree add` itself failed (rare after reconcile). Log and
      // try the next suffix rather than throwing — same recovery model.
      console.warn(
        `[worktree] git worktree add ${candidate.candidatePath} -b ${candidate.candidateBranch} ` +
          `(cwd=${repoRoot}) exit ${wt.code}: ` +
          `${wt.stderr.trim() || wt.stdout.trim() || '(no output)'}; ` +
          `trying next suffix`,
      );
      continue;
    }

    return candidate;
  }

  throw new Error(
    `Could not create a worktree for task "${taskTitle}" after ` +
      `${MAX_PATH_RETRY_SUFFIXES + 1} attempts: every candidate path under ` +
      `${canonicalWorktreePath(plan)}* is locked or unusable. ` +
      `Close any process / editor / Explorer window holding those directories ` +
      `open and try again.`,
  );
}

export function logFallbackWorktreeCandidate(
  candidate: AddedWorktreeCandidate,
  plan: WorktreeCandidatePlan,
  taskId: string,
): void {
  if (candidate.attempt === 0) return;
  console.log(
    `[worktree] used fallback path ${candidate.candidatePath} for task ${taskId} ` +
      `(canonical was locked; orphan dir at ${path.join(plan.worktreesDir, `${plan.slug}-${plan.shortId}`)} ` +
      `will need manual cleanup once the lock holder is closed)`,
  );
}
