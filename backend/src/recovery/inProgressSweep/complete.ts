// The auto-complete mutation: flip a stuck in_progress task to ready_to_merge.
//
// Uses the same disk-before-cache update (`updateTaskCrashSafe`) as the normal
// `/complete` path (there is no pty to clean up — the sweep only gets here
// when the task's pty is already dead), and reads any Pi sentinel file the
// dead extension wrote so the diagnostic log says *why* the model didn't call
// back itself.

import { getTask, updateTaskCrashSafe, type Task } from '../../tasks.js';
import { readPiShutdownSentinel } from '../../piExtension.js';

export type CompleteOutcome =
  | { ok: true }
  | { ok: false; error: unknown }
  // The task changed after the pass snapshotted it; left for the next pass.
  | { ok: false; stale: true };

export type AutoCompleteDeps = {
  getTask: typeof getTask;
  updateTaskCrashSafe: typeof updateTaskCrashSafe;
  readPiShutdownSentinel: typeof readPiShutdownSentinel;
};

const defaultDeps: AutoCompleteDeps = { getTask, updateTaskCrashSafe, readPiShutdownSentinel };

// Auto-complete `task` (which `decideAutoComplete` already cleared). Logs the
// diagnostic line — including the Pi shutdown sentinel, if any — before the
// transition so the operator can see why the model didn't call back itself.
export async function autoCompleteStuckTask(
  task: Task,
  commits: number,
  ageMs: number,
  deps: AutoCompleteDeps = defaultDeps,
): Promise<CompleteOutcome> {
  // `task` (and the live-pty set the verdict used) were captured at the start
  // of the pass, before an awaited git probe. A Resume, a lane move, a delete
  // or a real `/complete` landing meanwhile must not be overwritten with
  // ready_to_merge — that could hand a still-working agent's branch to
  // merge-all. Every task mutation bumps `updatedAt`, so any change at all
  // defers the task to the next pass, which re-evaluates it from scratch.
  const fresh = await deps.getTask(task.id);
  if (
    !fresh ||
    fresh.status !== 'in_progress' ||
    fresh.updatedAt !== task.updatedAt ||
    fresh.worktreePath !== task.worktreePath ||
    fresh.branch !== task.branch
  ) {
    return { ok: false, stale: true };
  }

  // Read the Pi sentinel (if any) so the diagnostic log explains why the
  // model didn't call back — quit-gated reason, fetch error, missing file...
  const sentinel = await deps.readPiShutdownSentinel(task.worktreePath as string);
  console.warn(
    `[in-progress-sweep] auto-completing task ${task.id} ` +
      `("${task.title.slice(0, 40)}") — PTY dead, branch ${task.branch} has ` +
      `${commits} commit(s), age ${Math.round(ageMs / 1000)}s. ` +
      `Pi sentinel: ${sentinel ? JSON.stringify(sentinel) : 'absent'}`,
  );

  try {
    const updated = await deps.updateTaskCrashSafe(task.id, {
      status: 'ready_to_merge',
      completedAt: Date.now(),
    });
    if (!updated) throw new Error('task state could not be written (or the task is gone)');
    return { ok: true };
  } catch (error) {
    console.error(
      `[in-progress-sweep] task ${task.id}: update failed:`,
      error,
    );
    return { ok: false, error };
  }
}
