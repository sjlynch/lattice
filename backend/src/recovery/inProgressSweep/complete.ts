// The auto-complete mutation: flip a stuck in_progress task to ready_to_merge.
//
// Runs through the same crash-safe update + (post-flip) pty cleanup as the
// normal `/complete` path, and reads any Pi sentinel file the dead extension
// wrote so the diagnostic log says *why* the model didn't call back itself.

import { updateTask, type Task } from '../../tasks.js';
import { readPiShutdownSentinel } from '../../piExtension.js';

export type CompleteOutcome = { ok: true } | { ok: false; error: unknown };

// Auto-complete `task` (which `decideAutoComplete` already cleared). Logs the
// diagnostic line — including the Pi shutdown sentinel, if any — before the
// transition so the operator can see why the model didn't call back itself.
export async function autoCompleteStuckTask(
  task: Task,
  commits: number,
  ageMs: number,
): Promise<CompleteOutcome> {
  // Read the Pi sentinel (if any) so the diagnostic log explains why the
  // model didn't call back — quit-gated reason, fetch error, missing file...
  const sentinel = await readPiShutdownSentinel(task.worktreePath as string);
  console.warn(
    `[in-progress-sweep] auto-completing task ${task.id} ` +
      `("${task.title.slice(0, 40)}") — PTY dead, branch ${task.branch} has ` +
      `${commits} commit(s), age ${Math.round(ageMs / 1000)}s. ` +
      `Pi sentinel: ${sentinel ? JSON.stringify(sentinel) : 'absent'}`,
  );

  try {
    await updateTask(task.id, {
      status: 'ready_to_merge',
      completedAt: Date.now(),
    });
    return { ok: true };
  } catch (error) {
    console.error(
      `[in-progress-sweep] task ${task.id}: updateTask failed:`,
      error,
    );
    return { ok: false, error };
  }
}
