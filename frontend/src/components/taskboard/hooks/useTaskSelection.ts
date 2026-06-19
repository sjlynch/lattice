import { useCallback, useState } from 'react';
import type { Task, TaskStatus } from '../../../api';

// Multi-selection on task cards: tracks the selected ids, the anchor card
// for shift-range selection, and which lane the selection is anchored in
// (selecting a card in a different lane resets the selection so cross-lane
// shift-ranges aren't allowed).
export function useTaskSelection(
  tasks: Task[],
  grouped: Record<TaskStatus, Task[]>,
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
      const laneTasks = grouped[laneId];
      const anchorIdx = laneTasks.findIndex((t) => t.id === anchorId);
      const targetIdx = laneTasks.findIndex((t) => t.id === id);
      if (anchorIdx === -1 || targetIdx === -1) {
        setSelectedIds(new Set([id]));
        setSelectionLane(laneId);
        return;
      }
      const lo = Math.min(anchorIdx, targetIdx);
      const hi = Math.max(anchorIdx, targetIdx);
      setSelectedIds(new Set(laneTasks.slice(lo, hi + 1).map((t) => t.id)));
      setSelectionLane(laneId);
    },
    [tasks, grouped, anchorId],
  );

  return {
    selectedIds,
    selectionLane,
    clearSelection,
    handleToggleSelect,
    handleRangeSelect,
  };
}
