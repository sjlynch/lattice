import { useCallback } from 'react';
import {
  abortTaskMerge as apiAbortTaskMerge,
  cancelMergeRun as apiCancelMergeRun,
  HttpError,
  mayHaveBeenApplied,
  mergeTask as apiMergeTask,
  retryTransient,
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
        // Waits out a backend restart (a 503 drain, or the backend down) —
        // but only failures the backend never acted on: a retried merge whose
        // first attempt did land would start a second conflict resolver.
        const res = await retryTransient(() => apiMergeTask(activeFolder, task.id), {
          retryIf: (err) => !mayHaveBeenApplied(err),
        });
        if (res.merged) return true;
        // Either a worktree merge conflict or a stash-pop conflict in main —
        // both are handled by a resolver Claude the BACKEND pre-spawned. With
        // no `serverId` that spawn failed: say so. Opening the terminal here
        // anyway would start the resolver over a serverless `/ws/terminal`,
        // bypassing the spawn chokepoint (MCP scope, system prompt, registry).
        if (!res.serverId) {
          showError(
            `Merge conflict in "${shortLabel(task.title)}", but its resolver could not be started` +
              `${res.resolverError ? `: ${res.resolverError}` : ''}. Try Merge again.`,
          );
          return false;
        }
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
    // Set when an attempt failed in a way that may still have started the run
    // (response lost mid-restart): a later 409 "already running" is then
    // most likely that run, not a reason to toast.
    let possiblyApplied = false;
    try {
      // Retries through a backend restart (502/503/504/network) instead of
      // toasting — a self-merge restarts the backend routinely.
      await retryTransient(() => apiStartMergeRun(activeFolder), {
        onRetry: (err) => {
          if (mayHaveBeenApplied(err)) possiblyApplied = true;
        },
      });
      // Run is now backend-driven; UI subscribes to /ws/merge-runs for
      // progress and conflict events. Closing the panel/tab won't stop it.
    } catch (err) {
      if (possiblyApplied && err instanceof HttpError && err.status === 409) return;
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
