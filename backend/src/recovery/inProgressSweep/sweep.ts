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
      await considerOneTask({ task, liveCwds, now, result });
    }
  }

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
  const verdict = await decideAutoComplete({ task, liveCwds, now });

  if (verdict.decision === 'skip') {
    recordSkip(task, verdict.reason, result);
    return;
  }

  const outcome = await autoCompleteStuckTask(task, verdict.commits, verdict.ageMs);
  if (outcome.ok) {
    result.flipped += 1;
  } else {
    result.skipped.push({ reason: 'updateTask threw', taskId: task.id });
  }
}

// Map a skip verdict to its log line (if any) and skip-accounting entry. The
// "expected-healthy" reasons (too-young / session-live) are intentionally
// silent and uncounted — they are normal in-flight tasks and logging them
// every pass would spam.
function recordSkip(task: Task, reason: SkipReason, result: SweepResult): void {
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
      // for now just log so the operator sees it.
      console.warn(
        `[in-progress-sweep] task ${task.id} ("${task.title.slice(0, 40)}") ` +
          `PTY dead, no commits on ${task.branch} — leaving at in_progress`,
      );
      result.skipped.push({ reason: 'pty dead, no commits', taskId: task.id });
      return;
  }
}

async function safeListKnownProjects(): Promise<string[]> {
  try {
    return await listKnownProjects();
  } catch (err) {
    console.warn('[in-progress-sweep] listKnownProjects threw:', err);
    return [];
  }
}
