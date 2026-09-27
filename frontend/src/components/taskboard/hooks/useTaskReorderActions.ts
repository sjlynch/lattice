import { useCallback } from 'react';
import {
  reorderTasks as apiReorderTasks,
  type Task,
  type TaskStatus,
} from '../../../api';
import { sortTasksForLane, type LaneSortMode } from '../laneSort';
import {
  appendOrder,
  fullLaneDropIndex,
  multiDropOrder,
  selectedTasksInVisibleOrder,
  singleDropOrder,
} from '../reorderMath';
import { type GroupedTasks } from './useTaskBoardState';

type UseTaskReorderActionsArgs = {
  activeFolder: string;
  tasks: Task[];
  grouped: GroupedTasks;
  // The search-filtered grouping the lanes actually render. Drop slot indices
  // count only these cards, so they are mapped back onto `grouped` before any
  // reorder math runs. Equal to `grouped` when no search is active.
  visibleGrouped: GroupedTasks;
  getLaneSortMode: (status: TaskStatus) => LaneSortMode;
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
  visibleGrouped,
  getLaneSortMode,
  clearSelection,
  showError,
}: UseTaskReorderActionsArgs) {
  // The destination lane in the SAME order the user sees it on the board.
  // Drop indices (targetIndex/hoverIndex) are measured against the lane's
  // visible order (sortTasksForLane), not the raw sortOrder grouping — so the
  // reorder math must splice into that exact array or the card lands at the
  // wrong slot. `getLaneSortMode` still returns the pre-drop mode here (the
  // 'manual' flip from the drop handler is queued, not yet applied), which is
  // precisely the ordering the index was derived from.
  const displayedLane = useCallback(
    (status: TaskStatus): Task[] =>
      sortTasksForLane(grouped[status], status, getLaneSortMode(status)),
    [grouped, getLaneSortMode],
  );
  // The destination lane exactly as rendered (search filter applied) — the
  // array the Lane's slot indices were measured against.
  const visibleLane = useCallback(
    (status: TaskStatus): Task[] =>
      sortTasksForLane(visibleGrouped[status], status, getLaneSortMode(status)),
    [visibleGrouped, getLaneSortMode],
  );
  // The dragged cards in the order the user actually sees them in their source
  // lane. Selection is anchored to a single lane, so all ids share a status;
  // we filter that lane's *displayed* order (not sortOrder/createdAt) so the
  // moved block keeps its visible top-to-bottom order.
  const srcTasksInVisibleOrder = useCallback(
    (ids: string[]): Task[] => {
      const sourceStatus = tasks.find((task) => ids.includes(task.id))?.status;
      if (!sourceStatus) return [];
      return selectedTasksInVisibleOrder(displayedLane(sourceStatus), ids);
    },
    [displayedLane, tasks],
  );
  // Move multiple tasks to a lane without a specific slot index (append).
  const moveMulti = useCallback(
    async (ids: string[], targetStatus: TaskStatus) => {
      if (!activeFolder) return;
      const srcTasks = srcTasksInVisibleOrder(ids);
      if (!srcTasks.length) return;
      const order = appendOrder(displayedLane(targetStatus), srcTasks, ids);
      try {
        await apiReorderTasks(activeFolder, targetStatus, order);
        clearSelection();
      } catch (err) {
        showError((err as Error).message);
      }
    },
    [activeFolder, clearSelection, displayedLane, showError, srcTasksInVisibleOrder],
  );

  // Drop multiple tasks at a specific position in the target lane.
  const dropAtMulti = useCallback(
    async (ids: string[], targetStatus: TaskStatus, targetIndex: number) => {
      if (!activeFolder) return;
      const srcTasks = srcTasksInVisibleOrder(ids);
      if (!srcTasks.length) return;
      const lane = displayedLane(targetStatus);
      const order = multiDropOrder(
        lane,
        srcTasks,
        ids,
        fullLaneDropIndex(lane, visibleLane(targetStatus), targetIndex, ids),
      );
      try {
        await apiReorderTasks(activeFolder, targetStatus, order);
        clearSelection();
      } catch (err) {
        showError((err as Error).message);
      }
    },
    [
      activeFolder,
      clearSelection,
      displayedLane,
      showError,
      srcTasksInVisibleOrder,
      visibleLane,
    ],
  );

  // Drop handler used by lane drop slots. `targetIndex` is the position in
  // the destination lane's visible (search-filtered) order where the task
  // should land; it is mapped onto the full lane before splicing.
  const dropAt = useCallback(
    async (id: string, targetStatus: TaskStatus, targetIndex: number) => {
      if (!activeFolder) return;
      const task = tasks.find((candidate) => candidate.id === id);
      if (!task) return;
      const shown = visibleLane(targetStatus);
      // No-op on screen (dropped onto its own visible slot): don't shuffle it
      // past hidden cards just because a search is filtering the lane.
      if (!singleDropOrder(shown, task, targetStatus, targetIndex)) return;
      const lane = displayedLane(targetStatus);
      const order = singleDropOrder(
        lane,
        task,
        targetStatus,
        fullLaneDropIndex(lane, shown, targetIndex, [id]),
      );
      if (!order) return; // no-op: dropped onto its own current slot
      try {
        await apiReorderTasks(activeFolder, targetStatus, order);
      } catch (err) {
        showError((err as Error).message);
      }
    },
    [activeFolder, displayedLane, showError, tasks, visibleLane],
  );

  return { moveMulti, dropAtMulti, dropAt };
}
