import { useCallback, useState } from 'react';
import type { Task, TaskStatus } from '../../../api';
import { sortTasksForLane, type LaneSortMode } from '../laneSort';

// The contiguous block of ids between `anchorId` and `targetId` inclusive, in
// the order the cards are actually rendered. `laneTasks` must already be the
// lane's *visible* order (sortTasksForLane) — slicing the raw sortOrder
// grouping instead would pick a different block than the one shown on screen.
// Returns null when either endpoint isn't present in that order.
export function rangeSelectedIds(
  laneTasks: Task[],
  anchorId: string,
  targetId: string,
): string[] | null {
  const anchorIdx = laneTasks.findIndex((t) => t.id === anchorId);
  const targetIdx = laneTasks.findIndex((t) => t.id === targetId);
  if (anchorIdx === -1 || targetIdx === -1) return null;
  const lo = Math.min(anchorIdx, targetIdx);
  const hi = Math.max(anchorIdx, targetIdx);
  return laneTasks.slice(lo, hi + 1).map((t) => t.id);
}

// Multi-selection on task cards: tracks the selected ids, the anchor card
// for shift-range selection, and which lane the selection is anchored in
// (selecting a card in a different lane resets the selection so cross-lane
// shift-ranges aren't allowed). `getLaneSortMode` supplies each lane's display
// sort so shift-ranges are computed over the on-screen order.
export function useTaskSelection(
  tasks: Task[],
  grouped: Record<TaskStatus, Task[]>,
  getLaneSortMode: (lane: TaskStatus) => LaneSortMode,
) {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [anchorId, setAnchorId] = useState<string | null>(null);
  const [selectionLane, setSelectionLane] = useState<TaskStatus | null>(null);

  const clearSelection = useCallback(() => {
    setSelectedIds(new Set());
    setAnchorId(null);
    setSelectionLane(null);
  }, []);

  const handleToggleSelect = useCallback(
    (id: string, laneId: TaskStatus) => {
      if (selectionLane !== null && selectionLane !== laneId) {
        setSelectedIds(new Set([id]));
        setSelectionLane(laneId);
        setAnchorId(id);
        return;
      }
      const next = new Set(selectedIds);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      setSelectedIds(next);
      setSelectionLane(next.size > 0 ? laneId : null);
      setAnchorId(id);
    },
    [selectedIds, selectionLane],
  );

  const handleRangeSelect = useCallback(
    (id: string, laneId: TaskStatus) => {
      const anchor = anchorId ? tasks.find((t) => t.id === anchorId) : null;
      if (!anchor || anchor.status !== laneId) {
        setSelectedIds(new Set([id]));
        setSelectionLane(laneId);
        setAnchorId(id);
        return;
      }
      // Slice the lane in the SAME order the user sees it (sortTasksForLane
      // with the per-lane mode — default 'recent' = arrivalTime desc), not the
      // raw sortOrder grouping. Those orders diverge in every non-open lane
      // (arrival ≠ createdAt), so slicing the grouped array would select a
      // different contiguous block than the one shown between anchor and target.
      const laneTasks = sortTasksForLane(
        grouped[laneId],
        laneId,
        getLaneSortMode(laneId),
      );
      const rangeIds = rangeSelectedIds(laneTasks, anchor.id, id);
      if (!rangeIds) {
        setSelectedIds(new Set([id]));
        setSelectionLane(laneId);
        return;
      }
      setSelectedIds(new Set(rangeIds));
      setSelectionLane(laneId);
    },
    [tasks, grouped, anchorId, getLaneSortMode],
  );

  return {
    selectedIds,
    selectionLane,
    clearSelection,
    handleToggleSelect,
    handleRangeSelect,
  };
}
