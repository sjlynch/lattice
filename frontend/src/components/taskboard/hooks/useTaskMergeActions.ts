import { useCallback, useRef } from 'react';
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
import type { AddTerminalSpec, TerminalSpec } from '../../../terminal/terminalTypes';
import { shortLabel } from '../lanes';

type AddTerminal = (spec: AddTerminalSpec, focus?: boolean) => string;
type CloseTerminalsForTask = (taskId: string, keep?: { id?: string; serverId?: string }) => void;

// A merge-kind tab for the task whose pty may still be running. A tab that was
// never activated has no status yet (panes lazy-mount), so only an explicit
// exit / loss / failed restore counts as dead.
export function findLiveResolverTab(
  terminals: readonly TerminalSpec[],
  taskId: string,
): TerminalSpec | undefined {
  return terminals.find(
    (t) =>
      t.taskId === taskId &&
      t.kind === 'merge' &&
      !!t.serverId &&
      t.status !== 'exited' &&
      t.status !== 'dead' &&
      t.restore !== 'failed',
  );
}

type UseTaskMergeActionsArgs = {
  activeFolder: string;
  tasks: Task[];
  mergeRun: MergeRun | null;
  addTerminal: AddTerminal;
  moveTask: (id: string, status: TaskStatus) => Promise<void>;
  showError: (message: string) => void;
  // The open tabs, to find a task's resolver that is still running, plus the
  // means to focus it and to drop a task's stale tabs before adding a new one.
  terminals?: readonly TerminalSpec[];
  focusTerminal?: (id: string) => void;
  closeTerminalsForTask?: CloseTerminalsForTask;
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
  terminals,
  focusTerminal,
  closeTerminalsForTask,
}: UseTaskMergeActionsArgs) {
  // Read through a ref so mergeTaskAction stays stable across every tab
  // status change (it is handed to every card).
  const terminalsRef = useRef(terminals);
  terminalsRef.current = terminals;
  // Tasks with a merge request in flight: a double-click is one request, not a
  // second that 409s ("Another merge is already in progress") into a toast.
  const mergingRef = useRef<Set<string>>(new Set());

  const mergeTaskAction = useCallback(
    async (task: Task): Promise<boolean> => {
      if (mergingRef.current.has(task.id)) return false;
      // The conflict pill / Merge on a task whose resolver is still working:
      // show that resolver. POSTing would spawn a second one into the same
      // worktree, both editing and committing the same merge. Only while the
      // task is conflict-flagged: a resolver that gave up (/merge-aborted
      // clears the flag) can leave its idle session open, and Merge must then
      // retry, not just show it again.
      const live = task.conflict
        ? findLiveResolverTab(terminalsRef.current ?? [], task.id)
        : undefined;
      if (live) {
        focusTerminal?.(live.id);
        return false;
      }
      mergingRef.current.add(task.id);
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
        // One resolver tab per task: drop any stale one (an ended resolver
        // from an earlier attempt) — never the pty just delivered, whose
        // registry `upsert` may have mounted its tab already (as
        // useMergeRunSync does).
        closeTerminalsForTask?.(task.id, { id: res.terminalId, serverId: res.serverId });
        // The backend handed back a resolver that was already running (this
        // tab didn't know it): the user asked to see it, so focus it.
        const existing = 'existingResolver' in res && res.existingResolver === true;
        addTerminal({
          id: res.terminalId,
          label: `merge:${shortLabel(task.title)}`,
          cwd: res.cwd,
          initialCommand: res.command,
          taskId: task.id,
          kind: 'merge',
          projectPath: task.projectPath,
          serverId: res.serverId,
        }, existing);
        return false;
      } catch (err) {
        showError(`Merge failed: ${(err as Error).message}`);
        return false;
      } finally {
        mergingRef.current.delete(task.id);
      }
    },
    [activeFolder, addTerminal, showError, focusTerminal, closeTerminalsForTask],
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
