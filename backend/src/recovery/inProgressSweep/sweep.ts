// Project/task scanning for the staleness sweep: snapshot live sessions once,
// walk every known project's in_progress tasks, and translate each
// eligibility verdict into logging, skip-accounting, and (when eligible) the
// auto-complete mutation.

import {
  listKnownProjects,
  listTasks,
  type Task,
} from '../../tasks.js';
import { collectLiveSessionCwds } from '../liveSessions.js';
import { forEachWithConcurrency } from '../concurrency.js';
import { autoCompleteStuckTask } from './complete.js';
import { decideAutoComplete, type SkipReason } from './eligibility.js';

export type SweepResult = {
  scanned: number;
  flipped: number;
  skipped: { reason: string; taskId: string }[];
};

export async function sweepStuckInProgressTasks(): Promise<SweepResult> {
  const result: SweepResult = { scanned: 0, flipped: 0, skipped: [] };
  const projects = await safeListKnownProjects();
  if (projects.length === 0) return result;

  // Snapshot live sessions once and reuse — proxyListSessions hits the
  // terminal-server over HTTP, no point hammering it per task.
  const liveCwds = await collectLiveSessionCwds();
  if (liveCwds === null) {
    // Terminal-server unreachable — we cannot distinguish "no live session"
    // from "can't tell". Skip this pass; the next tick will retry.
    console.warn(
      '[in-progress-sweep] terminal-server unreachable — skipping this pass',
    );
    return result;
  }

  const now = Date.now();
  const candidates: Task[] = [];
  for (const project of projects) {
    let tasks: Task[];
    try {
      tasks = await listTasks(project);
    } catch (err) {
      console.warn(
        `[in-progress-sweep] listTasks(${project}) failed:`,
        err,
      );
      continue;
    }
    for (const task of tasks) {
      if (task.status !== 'in_progress') continue;
      result.scanned += 1;
      candidates.push(task);
    }
  }
  // Each candidate costs one git spawn; tasks are independent, so probe them
  // with bounded fan-out rather than one at a time. Errors are isolated per
  // task so one wedged probe can't stall the pass.
  await forEachWithConcurrency(candidates, SWEEP_CONCURRENCY, async (task) => {
    try {
      await considerOneTask({ task, liveCwds, now, result });
    } catch (err) {
      console.warn(`[in-progress-sweep] task ${task.id} threw:`, err);
      result.skipped.push({ reason: 'consider threw', taskId: task.id });
    }
  });
  pruneNoCommitsCache(candidates);

  if (result.flipped > 0 || result.skipped.length > 0) {
    console.log(
      `[in-progress-sweep] scanned=${result.scanned} flipped=${result.flipped} skipped=${result.skipped.length}`,
    );
  }
  return result;
}

async function considerOneTask(args: {
  task: Task;
  liveCwds: Set<string>;
  now: number;
  result: SweepResult;
}): Promise<void> {
  const { task, liveCwds, now, result } = args;

  // A task whose pty is dead and whose branch has NO commits never changes
  // state on its own — re-probing it costs a git spawn + a warning line every
  // pass, forever (7,200/day per stuck task). Back off: re-probe at most once
  // per NO_COMMITS_BACKOFF_MS, and skip silently in between.
  if (isNoCommitsBackedOff(task, now)) {
    result.skipped.push({ reason: 'pty dead, no commits', taskId: task.id });
    return;
  }

  const verdict = await decideAutoComplete({ task, liveCwds, now });

  if (verdict.decision === 'skip') {
    if (verdict.reason.code === 'no-commits') {
      // Warn once per (task, branch) — the state cannot change until the
      // user resumes the task, at which point the key is pruned/reset.
      const warnedBefore = noteNoCommitsVerdict(task, now);
      recordSkip(task, verdict.reason, result, { quiet: warnedBefore });
      return;
    }
    clearNoCommitsVerdict(task);
    recordSkip(task, verdict.reason, result);
    return;
  }
  clearNoCommitsVerdict(task);

  const outcome = await autoCompleteStuckTask(task, verdict.commits, verdict.ageMs);
  if (outcome.ok) {
    result.flipped += 1;
  } else if ('stale' in outcome) {
    // Changed since the pass began (resumed / moved / completed) — the next
    // pass re-evaluates it. Silent, like the other expected-healthy skips.
  } else {
    result.skipped.push({ reason: 'updateTask threw', taskId: task.id });
  }
}

// Map a skip verdict to its log line (if any) and skip-accounting entry. The
// "expected-healthy" reasons (too-young / session-live) are intentionally
// silent and uncounted — they are normal in-flight tasks and logging them
// every pass would spam.
function recordSkip(
  task: Task,
  reason: SkipReason,
  result: SweepResult,
  opts: { quiet?: boolean } = {},
): void {
  switch (reason.code) {
    case 'too-young':
    case 'session-live':
      return;
    case 'no-worktree-or-branch':
      result.skipped.push({ reason: 'no worktree/branch', taskId: task.id });
      return;
    case 'commit-count-failed':
      console.warn(
        `[in-progress-sweep] task ${task.id}: branchCommitCount threw:`,
        reason.error,
      );
      result.skipped.push({ reason: 'commit-count threw', taskId: task.id });
      return;
    case 'no-commits':
      // We could re-enqueue a resume here, but that's a separate concern;
      // for now just log so the operator sees it (once per task — see the
      // back-off in considerOneTask).
      if (!opts.quiet) {
        console.warn(
          `[in-progress-sweep] task ${task.id} ("${task.title.slice(0, 40)}") ` +
            `PTY dead, no commits on ${task.branch} — leaving at in_progress`,
        );
      }
      result.skipped.push({ reason: 'pty dead, no commits', taskId: task.id });
      return;
  }
}

// ---- no-commits back-off ---------------------------------------------------

export const NO_COMMITS_BACKOFF_MS = 10 * 60 * 1000;
const SWEEP_CONCURRENCY = 8;

// (taskId, branch) → the last pass at which the probe said "no commits".
const noCommitsSeenAt = new Map<string, number>();

function noCommitsKey(task: Task): string {
  return `${task.id}\0${task.branch ?? ''}`;
}

// Still inside the back-off window after a `no-commits` verdict?
export function isNoCommitsBackedOff(task: Task, now: number): boolean {
  const seenAt = noCommitsSeenAt.get(noCommitsKey(task));
  return seenAt !== undefined && now - seenAt < NO_COMMITS_BACKOFF_MS;
}

// Record a `no-commits` verdict. Returns whether one was already on record
// (i.e. the warning has been logged before) so the caller can stay quiet.
export function noteNoCommitsVerdict(task: Task, now: number): boolean {
  const key = noCommitsKey(task);
  const seenBefore = noCommitsSeenAt.has(key);
  noCommitsSeenAt.set(key, now);
  return seenBefore;
}

export function clearNoCommitsVerdict(task: Task): void {
  noCommitsSeenAt.delete(noCommitsKey(task));
}

// Forget entries for tasks that are no longer in_progress candidates so the
// map can't grow with the board's history.
function pruneNoCommitsCache(candidates: readonly Task[]): void {
  const live = new Set(candidates.map(noCommitsKey));
  for (const key of noCommitsSeenAt.keys()) {
    if (!live.has(key)) noCommitsSeenAt.delete(key);
  }
}

// Test seam.
export function resetNoCommitsBackoffForTests(): void {
  noCommitsSeenAt.clear();
}

async function safeListKnownProjects(): Promise<string[]> {
  try {
    return await listKnownProjects();
  } catch (err) {
    console.warn('[in-progress-sweep] listKnownProjects threw:', err);
    return [];
  }
}
