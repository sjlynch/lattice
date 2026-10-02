import { useMemo, useState, type DragEvent } from 'react';
import type { TaskStatus } from '../../../api';
import { useSyncedRef } from '../../../hooks/useSyncedRef';
import { DRAG_MIME, parseDragPayload } from '../lanes';

type LaneDropCallbacks = {
  onMove: (id: string, status: TaskStatus) => void;
  onDropAt: (id: string, status: TaskStatus, index: number) => void;
  onMultiMove: (ids: string[], status: TaskStatus) => void;
  onMultiDropAt: (ids: string[], status: TaskStatus, index: number) => void;
};

export type LaneSlotProps = {
  onDragEnter: (e: DragEvent) => void;
  onDragOver: (e: DragEvent) => void;
  onDrop: (e: DragEvent) => void;
};

// Every drop slot (and the empty-lane target, slot 0) renders its index in
// this attribute; the shared slot handlers read it off `currentTarget`.
const SLOT_INDEX_ATTR = 'data-slot-index';

function slotIndexOf(e: DragEvent): number {
  return Number(e.currentTarget.getAttribute(SLOT_INDEX_ATTR));
}

function readIds(e: DragEvent): string[] {
  const raw = e.dataTransfer.getData(DRAG_MIME) || e.dataTransfer.getData('text/plain');
  return parseDragPayload(raw);
}

// Owns lane-level drop targeting: lane-background hover state, per-slot
// hover index, and the slot handler set. Lane-background drops do a
// status-only move (preserving the prior "drop anywhere" behavior);
// slot drops set both status and position.
export function useLaneDropTargets(
  laneId: TaskStatus,
  draggingId: string | null,
  callbacks: LaneDropCallbacks,
) {
  const [isOver, setIsOver] = useState(false);
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  // Read through refs by the slot handlers: `callbacks` is a fresh object on
  // every Lane render and `hoverIndex` moves throughout a drag, and neither
  // should rebuild the handlers every slot shares.
  const callbacksRef = useSyncedRef(callbacks);
  const hoverIndexRef = useSyncedRef(hoverIndex);

  function onDragOver(e: DragEvent) {
    if (!draggingId) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (!isOver) setIsOver(true);
  }
  function onDragLeave(e: DragEvent) {
    if (e.currentTarget.contains(e.relatedTarget as Node)) return;
    setIsOver(false);
    setHoverIndex(null);
  }
  function onDrop(e: DragEvent) {
    e.preventDefault();
    const ids = readIds(e);
    if (ids.length > 1) {
      if (hoverIndex !== null) callbacks.onMultiDropAt(ids, laneId, hoverIndex);
      else callbacks.onMultiMove(ids, laneId);
    } else if (ids.length === 1) {
      if (hoverIndex !== null) callbacks.onDropAt(ids[0], laneId, hoverIndex);
      else callbacks.onMove(ids[0], laneId);
    }
    setIsOver(false);
    setHoverIndex(null);
  }

  // One handler set shared by every slot in the lane, each handler finding its
  // slot through `data-slot-index`. It changes only with the lane or the drag
  // (`draggingId`), so a board update or a hover move re-renders just the
  // memoized DropSlots whose `active` flag flipped — not ~750 fresh closures.
  const slotHandlers = useMemo<LaneSlotProps>(
    () => ({
      onDragEnter: (e) => {
        if (!draggingId) return;
        e.preventDefault();
        e.stopPropagation();
        setHoverIndex(slotIndexOf(e));
      },
      onDragOver: (e) => {
        if (!draggingId) return;
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = 'move';
        const idx = slotIndexOf(e);
        if (hoverIndexRef.current !== idx) setHoverIndex(idx);
      },
      onDrop: (e) => {
        e.preventDefault();
        e.stopPropagation();
        const idx = slotIndexOf(e);
        const ids = readIds(e);
        if (ids.length > 1) {
          callbacksRef.current.onMultiDropAt(ids, laneId, idx);
        } else if (ids.length === 1) {
          callbacksRef.current.onDropAt(ids[0], laneId, idx);
        }
        setIsOver(false);
        setHoverIndex(null);
      },
    }),
    [laneId, draggingId, callbacksRef, hoverIndexRef],
  );

  return { isOver, hoverIndex, onDragOver, onDragLeave, onDrop, slotHandlers };
}
