import { updateTask, type Task } from '../tasks.js';
import { abortWorktreeMerge, isMidMerge } from '../worktree.js';
import { proxyKillSessionsByCwd } from '../terminalProxy.js';
import { notifySessionsFreed } from '../spawnQueue.js';

// Recover a task whose conflict resolver was abandoned. One caller:
//   - POST /api/tasks/:id/merge-aborted — a give-up resolver aborted the merge
//     and curled the callback (or the user clicked "Cancel" on the Resolving
//     strip).
// (The merge-run liveness backstop — a resolver pty that died / a wait that
// timed out with no callback — does NOT use this: `resolverWaitFailure.ts`
// stops the run and PRESERVES the conflict state, terminals and unfinished
// edits instead.)
//
// The resolution is being abandoned, so we: abort any lingering
// in-worktree merge (belt + braces — preflight also auto-recovers a stray
// MERGE_HEAD, but leaving one wedges the next /merge in the orphan-mid-merge
// state), clear the conflict flags (which is what makes a late /merged from the
// still-running resolver a harmless no-op — /merged and /complete's resolver
// branch are gated on task.conflict), and kill the lingering resolver pty by
// its worktree cwd so it stops churning against the abandoned resolution. The
// task is left at plain ready_to_merge to be retried on the next merge-all.
export async function recoverAbandonedResolverTask(task: Task): Promise<void> {
  if (task.worktreePath) {
    try {
      if (await isMidMerge(task.worktreePath)) {
        const aborted = await abortWorktreeMerge(task.worktreePath);
        if (!aborted.ok) {
          console.warn(
            `[abandoned-resolver] task ${task.id}: git merge --abort failed: ${aborted.message}`,
          );
        }
      }
    } catch (err) {
      console.warn(
        `[abandoned-resolver] task ${task.id}: abort check threw (continuing):`,
        err,
      );
    }
  }

  await updateTask(task.id, {
    conflict: undefined,
    conflictStartedAt: undefined,
  });

  // The worktree cwd is unique to this task and its original worktree agent was
  // already killed at the ready_to_merge transition, so the only session here
  // is the resolver. Fire-and-forget so callers (the /merge-aborted HTTP
  // response, the run worker's loop) aren't blocked on the terminal-server.
  if (task.worktreePath) {
    const wt = task.worktreePath;
    proxyKillSessionsByCwd(wt)
      // The kill freed a pty slot — poke the spawn queue so a deferred spawn
      // reuses it now instead of waiting for the next poll.
      .then(() => notifySessionsFreed())
      .catch(() => {});
  }
}
