import { useCallback } from 'react';
import {
  cancelQueuedRun as apiCancelQueuedRun,
  resumeTask as apiResumeTask,
  runTask as apiRunTask,
  type Task,
} from '../../../api';
import { useGitSetup } from '../../gitSetup/GitSetupProvider';
import type { RunHarnessSelection } from './useHarnessSelector';

type UseTaskLifecycleActionsArgs = {
  activeFolder: string;
  tasks: Task[];
  pickRunHarness: () => RunHarnessSelection;
  showError: (message: string) => void;
};

// Task lifecycle: run/resume a single task and the lane-level "run all"
// variants. Run/resume go through the backend spawn queue — the request is
// acknowledged immediately and the worktree-agent terminal is mounted later,
// when the queue admits the spawn, via the `task-spawned` WS event (see
// useTaskList). So these actions no longer mount a terminal themselves.
export function useTaskLifecycleActions({
  activeFolder,
  tasks,
  pickRunHarness,
  showError,
}: UseTaskLifecycleActionsArgs) {
  const { ensureGitRepo } = useGitSetup();

  const runTask = useCallback(
    async (task: Task) => {
      // Backstop for a task the create-time guard never saw: one filed through
      // the HTTP API, or a project whose `.git` disappeared afterwards. The
      // provider coalesces concurrent calls per project, so a "run all" over N
      // tasks still asks once rather than opening N dialogs.
      if (!(await ensureGitRepo(activeFolder))) return;
      try {
        const sel = pickRunHarness();
        await apiRunTask(activeFolder, task.id, sel.harness, sel.piModel);
      } catch (err) {
        showError(`Run failed: ${(err as Error).message}`);
      }
    },
    [activeFolder, ensureGitRepo, pickRunHarness, showError],
  );

  // Returns the ids enqueued so the caller can drive a progress strip.
  const runAllOpen = useCallback(() => {
    const openTasks = tasks
      .filter((task) => task.status === 'open')
      .sort((a, b) => a.createdAt - b.createdAt);
    // Enqueue every open task at once. Worktree setup now happens inside
    // queue thunks, paced by the queue's drain, so there is no longer any
    // need to serialize these to avoid hammering git.
    for (const task of openTasks) void runTask(task);
    return openTasks.map((task) => task.id);
  }, [runTask, tasks]);

  // Drop a queued run back to a plain Open task. The card's WS update
  // clears the "queued" badge once the backend persists it.
  const cancelQueuedRun = useCallback(
    async (task: Task) => {
      try {
        await apiCancelQueuedRun(activeFolder, task.id);
      } catch (err) {
        showError(`Cancel failed: ${(err as Error).message}`);
      }
    },
    [activeFolder, showError],
  );

  const resumeTaskAction = useCallback(
    async (task: Task) => {
      try {
        const sel = pickRunHarness();
        await apiResumeTask(activeFolder, task.id, sel.harness, sel.piModel);
      } catch (err) {
        showError(`Resume failed: ${(err as Error).message}`);
      }
    },
    [activeFolder, pickRunHarness, showError],
  );

  // Returns the ids re-spawned so the caller can drive a progress strip.
  const resumeAllInProgress = useCallback(() => {
    const list = tasks
      .filter((task) => task.status === 'in_progress' && !!task.worktreePath)
      .sort((a, b) => a.createdAt - b.createdAt);
    for (const task of list) void resumeTaskAction(task);
    return list.map((task) => task.id);
  }, [resumeTaskAction, tasks]);

  return {
    runTask,
    runAllOpen,
    cancelQueuedRun,
    resumeTaskAction,
    resumeAllInProgress,
  };
}
