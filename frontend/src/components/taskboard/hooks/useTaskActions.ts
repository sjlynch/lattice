import { useCallback } from 'react';
import {
  cancelMergeRun as apiCancelMergeRun,
  createTask as apiCreateTask,
  deleteTask as apiDeleteTask,
  mergeTask as apiMergeTask,
  reorderTasks as apiReorderTasks,
  resumeTask as apiResumeTask,
  runTask as apiRunTask,
  startMergeRun as apiStartMergeRun,
  updateTask as apiUpdateTask,
  type MergeRun,
  type Task,
  type TaskStatus,
} from '../../../api';
import type { TerminalSpec } from '../../../TerminalsContext';
import { shortLabel } from '../lanes';
import { compareTasksForLane, type GroupedTasks } from './useTaskBoardState';
import type { ResolvedHarness } from './useHarnessSelector';

type AddTerminal = (spec: Omit<TerminalSpec, 'id'>, focus?: boolean) => string;

type UseTaskActionsArgs = {
  activeFolder: string;
  tasks: Task[];
  grouped: GroupedTasks;
  mergeRun: MergeRun | null;
  addTerminal: AddTerminal;
  clearSelection: () => void;
  pickInterleaveHarness: () => ResolvedHarness;
  showError: (message: string) => void;
};

function selectedTasksInLaneOrder(tasks: Task[], ids: string[]): Task[] {
  return ids
    .map((id) => tasks.find((task) => task.id === id))
    .filter((task): task is Task => !!task)
    .sort(compareTasksForLane);
}

// Owns task-board action callbacks: CRUD, drag/drop reorders, lifecycle
// actions, merge-run controls, and terminal spawning side effects.
export function useTaskActions({
  activeFolder,
  tasks,
  grouped,
  mergeRun,
  addTerminal,
  clearSelection,
  pickInterleaveHarness,
  showError,
}: UseTaskActionsArgs) {
  const addTask = useCallback(
    async (status: TaskStatus, title: string, description?: string) => {
      if (!activeFolder || !title.trim()) return;
      try {
        const created = await apiCreateTask(activeFolder, title, description);
        // If we're adding to a non-open lane, immediately update its status.
        if (status !== 'open') {
          await apiUpdateTask(created.id, { status });
        }
      } catch (err) {
        showError((err as Error).message);
      }
    },
    [activeFolder, showError],
  );

  const moveTask = useCallback(
    async (id: string, status: TaskStatus) => {
      try {
        await apiUpdateTask(id, { status });
      } catch (err) {
        showError((err as Error).message);
      }
    },
    [showError],
  );

  // Move multiple tasks to a lane without a specific slot index (append).
  const moveMulti = useCallback(
    async (ids: string[], targetStatus: TaskStatus) => {
      if (!activeFolder) return;
      const srcTasks = selectedTasksInLaneOrder(tasks, ids);
      if (!srcTasks.length) return;
      const newLane = grouped[targetStatus].filter((task) => !ids.includes(task.id));
      newLane.push(...srcTasks);
      try {
        await apiReorderTasks(activeFolder, targetStatus, newLane.map((task) => task.id));
        clearSelection();
      } catch (err) {
        showError((err as Error).message);
      }
    },
    [activeFolder, clearSelection, grouped, showError, tasks],
  );

  // Drop multiple tasks at a specific position in the target lane.
  const dropAtMulti = useCallback(
    async (ids: string[], targetStatus: TaskStatus, targetIndex: number) => {
      if (!activeFolder) return;
      const srcTasks = selectedTasksInLaneOrder(tasks, ids);
      if (!srcTasks.length) return;
      const targetLane = grouped[targetStatus].slice();
      const remaining = targetLane.filter((task) => !ids.includes(task.id));
      let insertAt = targetIndex;
      for (let i = 0; i < targetIndex && i < targetLane.length; i++) {
        if (ids.includes(targetLane[i].id)) insertAt--;
      }
      insertAt = Math.max(0, Math.min(insertAt, remaining.length));
      remaining.splice(insertAt, 0, ...srcTasks);
      try {
        await apiReorderTasks(activeFolder, targetStatus, remaining.map((task) => task.id));
        clearSelection();
      } catch (err) {
        showError((err as Error).message);
      }
    },
    [activeFolder, clearSelection, grouped, showError, tasks],
  );

  // Drop handler used by lane drop slots. `targetIndex` is the position in
  // the destination lane's visible order where the task should land. Computes
  // the new ID order for the lane and ships it as a single batched reorder.
  const dropAt = useCallback(
    async (id: string, targetStatus: TaskStatus, targetIndex: number) => {
      if (!activeFolder) return;
      const task = tasks.find((candidate) => candidate.id === id);
      if (!task) return;
      const lane = grouped[targetStatus].slice();
      const fromIdx = lane.findIndex((candidate) => candidate.id === id);
      let insertAt = targetIndex;
      if (fromIdx !== -1) {
        lane.splice(fromIdx, 1);
        if (fromIdx < insertAt) insertAt -= 1;
      }
      insertAt = Math.max(0, Math.min(insertAt, lane.length));
      if (fromIdx === insertAt && task.status === targetStatus) return;
      lane.splice(insertAt, 0, task);
      try {
        await apiReorderTasks(activeFolder, targetStatus, lane.map((candidate) => candidate.id));
      } catch (err) {
        showError((err as Error).message);
      }
    },
    [activeFolder, grouped, showError, tasks],
  );

  const editTask = useCallback(
    async (id: string, updates: { title?: string; description?: string }) => {
      try {
        await apiUpdateTask(id, updates);
      } catch (err) {
        showError((err as Error).message);
      }
    },
    [showError],
  );

  const deleteTask = useCallback(
    async (id: string) => {
      try {
        await apiDeleteTask(id);
      } catch (err) {
        showError((err as Error).message);
      }
    },
    [showError],
  );

  const runTask = useCallback(
    async (task: Task) => {
      try {
        const res = await apiRunTask(task.id, pickInterleaveHarness());
        addTerminal({
          label: shortLabel(task.title),
          cwd: res.worktreePath,
          initialCommand: res.command,
          taskId: task.id,
          projectPath: task.projectPath,
          serverId: res.serverId,
        }, false);
      } catch (err) {
        showError(`Run failed: ${(err as Error).message}`);
      }
    },
    [addTerminal, pickInterleaveHarness, showError],
  );

  const runAllOpen = useCallback(async () => {
    const openTasks = tasks
      .filter((task) => task.status === 'open')
      .sort((a, b) => a.createdAt - b.createdAt);
    for (const task of openTasks) {
      // sequentially to avoid hammering git
      // eslint-disable-next-line no-await-in-loop
      await runTask(task);
    }
  }, [runTask, tasks]);

  const resumeTaskAction = useCallback(
    async (task: Task) => {
      try {
        const res = await apiResumeTask(task.id, pickInterleaveHarness());
        addTerminal({
          label: shortLabel(task.title),
          cwd: res.worktreePath,
          initialCommand: res.command,
          taskId: task.id,
          projectPath: task.projectPath,
          serverId: res.serverId,
        }, false);
      } catch (err) {
        showError(`Resume failed: ${(err as Error).message}`);
      }
    },
    [addTerminal, pickInterleaveHarness, showError],
  );

  const resumeAllInProgress = useCallback(async () => {
    const list = tasks
      .filter((task) => task.status === 'in_progress' && !!task.worktreePath)
      .sort((a, b) => a.createdAt - b.createdAt);
    for (const task of list) {
      // eslint-disable-next-line no-await-in-loop
      await resumeTaskAction(task);
    }
  }, [resumeTaskAction, tasks]);

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

  return {
    addTask,
    moveTask,
    moveMulti,
    dropAtMulti,
    dropAt,
    editTask,
    deleteTask,
    runTask,
    runAllOpen,
    resumeTaskAction,
    resumeAllInProgress,
    mergeTaskAction,
    mergeAllReady,
    cancelActiveRun,
    markAllQaDone,
  };
}
