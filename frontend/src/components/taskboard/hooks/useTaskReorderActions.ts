import { useCallback } from 'react';
import {
  reorderTasks as apiReorderTasks,
  type Task,
  type TaskStatus,
} from '../../../api';
import { compareTasksForLane, type GroupedTasks } from './useTaskBoardState';

function selectedTasksInLaneOrder(tasks: Task[], ids: string[]): Task[] {
  return ids
    .map((id) => tasks.find((task) => task.id === id))
    .filter((task): task is Task => !!task)
    .sort(compareTasksForLane);
}

type UseTaskReorderActionsArgs = {
  activeFolder: string;
  tasks: Task[];
  grouped: GroupedTasks;
  clearSelection: () => void;
  showError: (message: string) => void;
};

// Drag/drop reorder math: single-task position drops plus multi-task
// move/drop with lane-order preservation. Each operation computes the
// destination lane's new ID order and ships a single batched reorder.
export function useTaskReorderActions({
  activeFolder,
  tasks,
  grouped,
  clearSelection,
  showError,
}: UseTaskReorderActionsArgs) {
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
  // the destination lane's visible order where the task should land.
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

  return { moveMulti, dropAtMulti, dropAt };
}
