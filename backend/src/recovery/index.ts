// Crash-recovery sweep run on every backend boot.
//
// Detects ready_to_merge tasks whose branch no longer exists. finalize now
// writes qa BEFORE scheduling cleanup (and keeps the branch when that write
// fails), so this is a backstop for older backends / out-of-band deletions:
// a Lattice cleanup only ever deletes a branch after its FF landed, so the
// work is assumed to be in main.

import {
  listReadyToMergeTasks,
  restoreAllProjectsFromBackup,
  updateTaskCrashSafe,
  type Task,
} from '../tasks.js';
import { checkBranchExists, gitDirExists, recoverPendingSnapshots } from '../worktree.js';
import { forEachWithConcurrency } from './concurrency.js';
import { sweepOrphanedWorktrees } from './worktreeSweep.js';
import { sweepOrphanedPushSessions } from './pushSessionSweep.js';
import { sweepOrphanedQaSessions } from './qaSessionSweep.js';
import { sweepOrphanedPostMergeHookSessions } from './postMergeHookSweep.js';
import {
  sweepStaleClaudeProjectEntries,
  sweepOrphanedClaudeConfigTempFiles,
} from './claudeConfigSweep.js';

export { resumeInterruptedMergeRuns } from './mergeRunResume.js';
export { resumeInterruptedWorkflowRuns } from './workflowRunResume.js';
export { resumeQueuedTaskRuns } from './queuedRunResume.js';
export { sweepOrphanedWorktrees } from './worktreeSweep.js';
export { sweepOrphanedPushSessions } from './pushSessionSweep.js';
export { sweepOrphanedQaSessions } from './qaSessionSweep.js';
export { sweepOrphanedPostMergeHookSessions } from './postMergeHookSweep.js';
export {
  sweepStaleClaudeProjectEntries,
  sweepOrphanedClaudeConfigTempFiles,
} from './claudeConfigSweep.js';
export {
  startWorktreeResidueSweepLoop,
  stopWorktreeResidueSweepLoop,
  requestWorktreeResidueSweep,
  runWorktreeResidueSweepPass,
  WORKTREE_RESIDUE_SWEEP_INTERVAL_MS,
} from './worktreeResidueSweepLoop.js';
export {
  startInProgressSweepLoop,
  stopInProgressSweepLoop,
  sweepStuckInProgressTasks,
  IN_PROGRESS_SWEEP_INTERVAL_MS,
} from './inProgressSweep.js';

export async function recoverOrphanedTasks(): Promise<void> {
  // Phase 1: repair `.lattice/tasks.json` from `.lattice/tasks.backup.json`
  // for any project where the main file went missing or unparseable. Must
  // run BEFORE any tasks.ts read so the cache is populated from the
  // restored file. Logs loudly per project that gets restored.
  await runStartupRecoveryStep('restoreAllProjectsFromBackup', () => restoreAllProjectsFromBackup());

  // Phase 1b: scan ~/.lattice/snapshots/ for any orphan snapshots from a
  // crashed run and restore them into their original repos. Replaces the
  // prior `git stash` based recovery (which depended on the stash entry
  // surviving across restarts — failure-prone, see snapshot.ts header).
  await runStartupRecoveryStep('recoverPendingSnapshots', () => recoverPendingSnapshots());

  // Phase 1c: reclaim orphaned worktrees (failed background cleanups,
  // crashed runs, legacy in-project worktrees). cleanup.ts deliberately
  // leaves a worktree dir in place when `git worktree remove` fails
  // mid-run; this is the retry that makes it converge.
  await runStartupRecoveryStep('sweepOrphanedWorktrees', () => sweepOrphanedWorktrees());

  // Phase 1d: reclaim orphaned push-session scratch dirs left behind by
  // a /done cleanup that lost its EBUSY race with the still-shutting-down
  // PTY (the in-memory registry is empty at boot, so anything still on
  // disk is by definition stale). Mirrors sweepOrphanedWorktrees.
  await runStartupRecoveryStep('sweepOrphanedPushSessions', () => sweepOrphanedPushSessions());

  // Phase 1e: same convergence layer for QA e2e-run scratch dirs.
  await runStartupRecoveryStep('sweepOrphanedQaSessions', () => sweepOrphanedQaSessions());

  // Phase 1f: same convergence layer for post-merge hook scratch dirs.
  await runStartupRecoveryStep('sweepOrphanedPostMergeHookSessions', () => sweepOrphanedPostMergeHookSessions());

  // Phase 1g: reclaim dead `projects[<cwd>]` entries in ~/.claude.json that
  // point at Lattice ephemeral worktree/scratch dirs already removed (incl. the
  // ones the sweeps above just reclaimed). Each spawn pre-seeds one such entry
  // (trust + managed MCP) and nothing else prunes them, so the map grew by one
  // per run forever. Global, not per-project — one shared file. See
  // recovery/claudeConfigSweep.ts.
  await runStartupRecoveryStep('sweepStaleClaudeProjectEntries', () => sweepStaleClaudeProjectEntries());

  // Phase 1h: delete orphaned ~/.claude.json.lattice-*.tmp temps left by a
  // writer hard-killed between its temp write and rename. The fixed
  // atomic-write path now cleans up on a failed rename, but this reclaims
  // legacy orphans (and any from a true hard-kill). See claudeConfigSweep.ts.
  await runStartupRecoveryStep('sweepOrphanedClaudeConfigTempFiles', () => sweepOrphanedClaudeConfigTempFiles());

  await runStartupRecoveryStep('recoverOrphanedTasks', () => recoverReadyTasksWithDeletedBranches());
}

async function runStartupRecoveryStep(
  label: string,
  step: () => Promise<void>,
): Promise<void> {
  try {
    await step();
  } catch (err) {
    console.error(`[startup] ${label} failed:`, err);
  }
}

// Bounded fan-out (each probe is one git spawn, and this phase runs before
// `listen`, so a serial walk delayed the port by one spawn per task), with
// per-task isolation: one task's failure never skips the rest.
async function recoverReadyTasksWithDeletedBranches(): Promise<void> {
  const stuckTasks = await listReadyToMergeTasks();
  await forEachWithConcurrency(stuckTasks, RECOVERY_CONCURRENCY, async (task) => {
    try {
      await recoverTaskIfBranchWasDeleted(task);
    } catch (err) {
      console.warn(
        `[startup] task ${task.id}: branch probe failed — leaving at ready_to_merge:`,
        err,
      );
    }
  });
}

const RECOVERY_CONCURRENCY = 8;

// Only a CONFIRMED absence (git exit 0, no match) moves the task. A missing
// `.git` (project moved/deleted) or a git failure (checkBranchExists throws)
// is "can't tell" — the task is left alone rather than stripped of its branch.
async function recoverTaskIfBranchWasDeleted(task: Task): Promise<void> {
  if (!task.branch) return;
  if (!(await gitDirExists(task.projectPath))) return;

  const exists = await checkBranchExists(task.projectPath, task.branch);
  if (exists) return;

  console.log(
    `[startup] task ${task.id} ("${task.title.slice(0, 40)}") branch deleted but status is ready_to_merge — recovering to qa`,
  );
  await updateTaskCrashSafe(task.id, {
    status: 'qa',
    mergedAt: task.mergedAt ?? Date.now(),
    worktreePath: undefined,
    branch: undefined,
    conflict: undefined,
    conflictStartedAt: undefined,
  });
}
