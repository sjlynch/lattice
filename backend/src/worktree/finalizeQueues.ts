// Per-project promise queues used by finalize.ts. Extracted so
// finalizeMergedTask can stay focused on the FF / re-sync / state-transition
// decision tree while the serialization + background-cleanup plumbing lives
// here. Two independent queues:
//   - runSerializedFinalize: serializes finalize work per project (HEAD safety).
//   - scheduleWorktreeCleanup: decouples background worktree teardown.

import { cleanupWorktreeForTask } from './cleanup.js';
import { withProjectMutation } from '../projectRunLock.js';

// Per-project promise queue. fastForwardMain modifies main's HEAD and must not
// run concurrently with another finalize for the same project — the second
// caller's branch would have been merged against a stale HEAD and would no
// longer be a fast-forward ancestor of main.

// Run `fn` exclusively for `projectPath`: it won't start until the previous
// finalize for the same project has settled, and the next caller waits on it.
// The slot is released in a `finally`, so an early return or throw inside `fn`
// never jams the queue.
export async function runSerializedFinalize<T>(
  projectPath: string,
  fn: () => Promise<T>,
): Promise<T> {
  return withProjectMutation(projectPath, fn);
}

// Per-project queue for background worktree cleanup. Cleanup runs sequentially
// per project (so two `git worktree remove` calls don't race on .git/index.lock)
// but is decoupled from finalize itself: a hung cleanup on Windows (where a
// process holding the worktree dir open could deadlock `git worktree remove`)
// must not stall the run worker, since the task is already qa-on-disk.
const cleanupQueues = new Map<string, Promise<void>>();

export function scheduleWorktreeCleanup(
  projectPath: string,
  worktreePath: string,
  branchName: string,
  taskId: string,
): void {
  const prev = cleanupQueues.get(projectPath) ?? Promise.resolve();
  const next = prev.then(async () => {
    console.log(`[finalize] cleaning up worktree ${worktreePath}...`);
    try {
      await cleanupWorktreeForTask(projectPath, worktreePath, branchName);
      console.log(`[finalize] worktree cleanup done for ${taskId}`);
    } catch (err) {
      console.error(
        `[finalize] background cleanup failed for ${taskId} (task already qa, leaves orphaned worktree dir):`,
        err,
      );
    }
  });
  cleanupQueues.set(projectPath, next);
  // Detach so an unhandled rejection in this chain never crashes the process —
  // the .then handler above already swallows errors but belt-and-braces.
  next.catch(() => {});
}
