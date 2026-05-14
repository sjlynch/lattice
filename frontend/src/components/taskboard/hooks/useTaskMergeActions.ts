import { useCallback } from 'react';
import {
  cancelMergeRun as apiCancelMergeRun,
  mergeTask as apiMergeTask,
  startMergeRun as apiStartMergeRun,
  type MergeRun,
  type Task,
  type TaskStatus,
} from '../../../api';
import type { TerminalSpec } from '../../../TerminalsContext';
import { shortLabel } from '../lanes';

type AddTerminal = (spec: Omit<TerminalSpec, 'id'>, focus?: boolean) => string;

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
        const res = await apiMergeTask(task.id);
        if (res.merged) return true;
        // Either a worktree merge conflict or a stash-pop conflict in main —
        // both are handled by spawning a resolver Claude as a merge terminal.
        addTerminal({
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
    [addTerminal, showError],
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

  const markAllQaDone = useCallback(async () => {
    const qaTasks = tasks.filter((task) => task.status === 'qa');
    await Promise.all(qaTasks.map((task) => moveTask(task.id, 'done')));
  }, [moveTask, tasks]);

  return { mergeTaskAction, mergeAllReady, cancelActiveRun, markAllQaDone };
}
