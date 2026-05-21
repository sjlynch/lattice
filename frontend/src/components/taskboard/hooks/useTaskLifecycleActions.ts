import { useCallback } from 'react';
import {
  cancelQueuedRun as apiCancelQueuedRun,
  resumeTask as apiResumeTask,
  runTask as apiRunTask,
  type Task,
} from '../../../api';
import type { ResolvedHarness } from './useHarnessSelector';

type UseTaskLifecycleActionsArgs = {
  tasks: Task[];
  pickInterleaveHarness: () => ResolvedHarness;
  showError: (message: string) => void;
};

// Task lifecycle: run/resume a single task and the lane-level "run all"
// variants. Run/resume go through the backend spawn queue — the request is
// acknowledged immediately and the worktree-agent terminal is mounted later,
// when the queue admits the spawn, via the `task-spawned` WS event (see
// useTaskList). So these actions no longer mount a terminal themselves.
export function useTaskLifecycleActions({
  tasks,
  pickInterleaveHarness,
  showError,
}: UseTaskLifecycleActionsArgs) {
  const runTask = useCallback(
    async (task: Task) => {
      try {
        await apiRunTask(task.id, pickInterleaveHarness());
      } catch (err) {
        showError(`Run failed: ${(err as Error).message}`);
      }
    },
    [pickInterleaveHarness, showError],
  );

  const runAllOpen = useCallback(() => {
    const openTasks = tasks
      .filter((task) => task.status === 'open')
      .sort((a, b) => a.createdAt - b.createdAt);
    // Enqueue every open task at once. Worktree setup now happens inside
    // queue thunks, paced by the queue's drain, so there is no longer any
    // need to serialize these to avoid hammering git.
    for (const task of openTasks) void runTask(task);
  }, [runTask, tasks]);

  // Drop a queued run back to a plain Open task. The card's WS update
  // clears the "queued" badge once the backend persists it.
  const cancelQueuedRun = useCallback(
    async (task: Task) => {
      try {
        await apiCancelQueuedRun(task.id);
      } catch (err) {
        showError(`Cancel failed: ${(err as Error).message}`);
      }
    },
    [showError],
  );

  const resumeTaskAction = useCallback(
    async (task: Task) => {
      try {
        await apiResumeTask(task.id, pickInterleaveHarness());
      } catch (err) {
        showError(`Resume failed: ${(err as Error).message}`);
      }
    },
    [pickInterleaveHarness, showError],
  );

  const resumeAllInProgress = useCallback(() => {
    const list = tasks
      .filter((task) => task.status === 'in_progress' && !!task.worktreePath)
      .sort((a, b) => a.createdAt - b.createdAt);
    for (const task of list) void resumeTaskAction(task);
  }, [resumeTaskAction, tasks]);

  return {
    runTask,
    runAllOpen,
    cancelQueuedRun,
    resumeTaskAction,
    resumeAllInProgress,
  };
}
