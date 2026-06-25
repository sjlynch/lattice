// The eligibility decision for a single `in_progress` task: should the sweep
// auto-complete it, and if not, exactly why?
//
// What we look for before flipping a task in_progress → ready_to_merge:
//   1. Task has a `worktreePath` and `branch`.
//   2. The task has been `in_progress` for at least `MIN_AGE_MS` so a task
//      that is mid-startup (worktree created, model still booting) isn't
//      false-positively flipped.
//   3. The terminal-server has NO live session whose `cwd` is the worktree
//      (the original spawn is dead and the model is not coming back).
//   4. The branch has at least one commit (work was actually done — same
//      check the `/complete` route uses before transitioning).
//
// The decision is returned as a small discriminated union so the caller can
// log/account for each outcome without re-deriving why. This module only
// *reads* (live-cwd membership + branch commit count); the mutation lives in
// `./complete.ts`.

import type { Task } from '../../tasks.js';
import { branchCommitCount } from '../../worktree.js';
import { normalizeCwd } from '../liveSessions.js';
import { MIN_AGE_MS } from './config.js';

// Why a task was *not* auto-completed. `too-young` and `session-live` are the
// expected-healthy cases (a task mid-flight or still being worked); the rest
// are genuine "couldn't / shouldn't act" outcomes the caller surfaces.
export type SkipReason =
  | { code: 'no-worktree-or-branch' }
  | { code: 'too-young' }
  | { code: 'session-live' }
  | { code: 'commit-count-failed'; error: unknown }
  | { code: 'no-commits' };

export type EligibilityVerdict =
  | { decision: 'skip'; reason: SkipReason }
  | { decision: 'complete'; commits: number; ageMs: number };

// Decide whether `task` is a stuck in_progress task that should be flipped to
// ready_to_merge. Pure of mutation: it inspects state and reports a verdict.
export async function decideAutoComplete(args: {
  task: Task;
  liveCwds: Set<string>;
  now: number;
}): Promise<EligibilityVerdict> {
  const { task, liveCwds, now } = args;

  if (!task.worktreePath || !task.branch) {
    return { decision: 'skip', reason: { code: 'no-worktree-or-branch' } };
  }

  const ageMs = now - (task.startedAt ?? task.createdAt);
  if (ageMs < MIN_AGE_MS) {
    return { decision: 'skip', reason: { code: 'too-young' } };
  }

  if (liveCwds.has(normalizeCwd(task.worktreePath))) {
    // Model is still running — leave it alone.
    return { decision: 'skip', reason: { code: 'session-live' } };
  }

  let commits: number;
  try {
    commits = await branchCommitCount(task.projectPath, task.branch);
  } catch (error) {
    return { decision: 'skip', reason: { code: 'commit-count-failed', error } };
  }

  if (commits === 0) {
    // PTY dead, no commits — there is nothing to flip to. Likely the model
    // exited before doing anything.
    return { decision: 'skip', reason: { code: 'no-commits' } };
  }

  return { decision: 'complete', commits, ageMs };
}
