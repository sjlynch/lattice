// Crash-recovery sweep run on every backend boot.
//
// Detects ready_to_merge tasks whose branch no longer exists. This happens
// when finalizeMergedTask completed FF + cleanup but the server crashed
// before writing the qa status. The branch being gone is the reliable
// indicator: cleanup ran, so the task is already in main.

import {
  listReadyToMergeTasks,
  updateTaskCrashSafe,
  restoreAllProjectsFromBackup,
} from './tasks.js';
import { checkBranchExists } from './worktree.js';

export async function recoverOrphanedTasks(): Promise<void> {
  // Phase 1: repair `.lattice/tasks.json` from `.lattice/tasks.backup.json`
  // for any project where the main file went missing or unparseable. Must
  // run BEFORE any tasks.ts read so the cache is populated from the
  // restored file. Logs loudly per project that gets restored.
  try {
    await restoreAllProjectsFromBackup();
  } catch (err) {
    console.error('[startup] restoreAllProjectsFromBackup failed:', err);
  }

  try {
    const stuckTasks = await listReadyToMergeTasks();
    for (const task of stuckTasks) {
      if (!task.branch) continue;
      const exists = await checkBranchExists(task.projectPath, task.branch);
      if (!exists) {
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
    }
  } catch (err) {
    console.error('[startup] recoverOrphanedTasks failed:', err);
  }
}
