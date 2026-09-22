import { useCallback } from 'react';
import {
  abortTaskMerge as apiAbortTaskMerge,
  cancelMergeRun as apiCancelMergeRun,
  mergeTask as apiMergeTask,
  startMergeRun as apiStartMergeRun,
  type MergeRun,
  type Task,
  type TaskStatus,
} from '../../../api';
import type { AddTerminalSpec } from '../../../terminal/terminalTypes';
import { shortLabel } from '../lanes';

type AddTerminal = (spec: AddTerminalSpec, focus?: boolean) => string;

type UseTaskMergeActionsArgs = {
  activeFolder: string;
  tasks: Task[];
  mergeRun: MergeRun | null;
  addTerminal: AddTerminal;
  moveTask: (id: string, status: TaskStatus) => Promise<void>;
  showError: (message: string) => void;
};

// Merge actions: per-task merge (with resolver-Claude spawn on conflict),
// the backend-driven "merge all", run cancellation, and the QA-bulk-done
// shortcut. Receives moveTask from the CRUD hook so QA bulk-done shares
// the same error-handling boundary.
export function useTaskMergeActions({
  activeFolder,
  tasks,
  mergeRun,
  addTerminal,
  moveTask,
  showError,
}: UseTaskMergeActionsArgs) {
  const mergeTaskAction = useCallback(
    async (task: Task): Promise<boolean> => {
      try {
        const res = await apiMergeTask(activeFolder, task.id);
        if (res.merged) return true;
        // Either a worktree merge conflict or a stash-pop conflict in main —
        // both are handled by spawning a resolver Claude as a merge terminal.
        addTerminal({
          id: res.terminalId,
          label: `merge:${shortLabel(task.title)}`,
          cwd: res.cwd,
          initialCommand: res.command,
          taskId: task.id,
          kind: 'merge',
          projectPath: task.projectPath,
          serverId: res.serverId,
        }, false);
        return false;
      } catch (err) {
        showError(`Merge failed: ${(err as Error).message}`);
        return false;
      }
    },
    [activeFolder, addTerminal, showError],
  );

  const mergeAllReady = useCallback(async () => {
    if (!activeFolder) return;
    try {
      await apiStartMergeRun(activeFolder);
      // Run is now backend-driven; UI subscribes to /ws/merge-runs for
      // progress and conflict events. Closing the panel/tab won't stop it.
    } catch (err) {
      showError(`Merge all failed to start: ${(err as Error).message}`);
    }
  }, [activeFolder, showError]);

  const cancelActiveRun = useCallback(async () => {
    if (!mergeRun) return;
    try {
      await apiCancelMergeRun(mergeRun.id);
    } catch (err) {
      showError(`Cancel failed: ${(err as Error).message}`);
    }
  }, [mergeRun, showError]);

  // Escape hatch for the "Resolving N conflicts" strip: abandon every stuck
  // conflict (resolver died / merge run was cancelled / backend restarted
  // mid-resolution) by aborting any lingering mid-merge and clearing the
  // conflict flag, returning each task to plain ready_to_merge. Without this
  // the strip is a dead end — it renders whenever any ready_to_merge task has
  // conflict:true, with no Cancel button of its own and (unlike the active-run
  // strip) no run to cancel.
  const clearStuckConflicts = useCallback(async () => {
    const stuck = tasks.filter((task) => task.conflict);
    if (stuck.length === 0) return;
    const results = await Promise.allSettled(
      stuck.map((task) => apiAbortTaskMerge(activeFolder, task.id)),
    );
    const failed = results.filter((r) => r.status === 'rejected').length;
    if (failed > 0) {
      showError(
        `Failed to clear ${failed} of ${stuck.length} stuck conflict${stuck.length === 1 ? '' : 's'}`,
      );
    }
  }, [activeFolder, tasks, showError]);

  // Fire each move-to-done without awaiting (moveTask handles its own errors)
  // and return the ids so the caller can drive a progress strip immediately.
  const markAllQaDone = useCallback(() => {
    const qaTasks = tasks.filter((task) => task.status === 'qa');
    for (const task of qaTasks) void moveTask(task.id, 'done');
    return qaTasks.map((task) => task.id);
  }, [moveTask, tasks]);

  return {
    mergeTaskAction,
    mergeAllReady,
    cancelActiveRun,
    clearStuckConflicts,
    markAllQaDone,
  };
}
