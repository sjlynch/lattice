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
  let lastFailure = '';
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
      lastFailure = `could not reconcile ${candidate.candidatePath}`;
      continue;
    }

    const wt = await projectGit(
      repoRoot,
      ['worktree', 'add', candidate.candidatePath, '-b', candidate.candidateBranch],
    );
    if (wt.code !== 0) {
      const detail = wt.stderr.trim() || wt.stdout.trim() || '(no output)';
      // An empty repo (`git init` with no commits) has no HEAD to branch
      // from, so `git worktree add -b` fails with the same deterministic
      // error on every suffix. Retrying 5 times is pointless and the
      // generic "path locked" message is flat-out wrong — surface the
      // real cause and bail immediately so the user knows to commit.
      if (/not a valid object name:?\s*'?HEAD'?/i.test(detail)) {
        throw new Error(
          `Cannot create a worktree for task "${taskTitle}": the repository ` +
            `at ${repoRoot} has no commits yet (no HEAD to branch from). ` +
            `Make an initial commit (e.g. ` +
            `\`git commit --allow-empty -m "init"\`) before running tasks.`,
        );
      }
      // `git worktree add` itself failed (rare after reconcile). Log and
      // try the next suffix rather than throwing — same recovery model.
      console.warn(
        `[worktree] git worktree add ${candidate.candidatePath} -b ${candidate.candidateBranch} ` +
          `(cwd=${repoRoot}) exit ${wt.code}: ${detail}; trying next suffix`,
      );
      lastFailure = detail;
      continue;
    }

    return candidate;
  }

  throw new Error(
    `Could not create a worktree for task "${taskTitle}" after ` +
      `${MAX_PATH_RETRY_SUFFIXES + 1} attempts under ` +
      `${canonicalWorktreePath(plan)}*. Last git error: ${lastFailure || '(unknown)'}. ` +
      `If a candidate path is locked, close any process / editor / Explorer ` +
      `window holding those directories open and try again.`,
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
