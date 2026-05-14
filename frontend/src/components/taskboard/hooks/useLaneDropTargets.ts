import { useState, type DragEvent } from 'react';
import type { TaskStatus } from '../../../api';
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

// Owns lane-level drop targeting: lane-background hover state, per-slot
// hover index, and slotProps factories. Lane-background drops do a
// status-only move (preserving the prior "drop anywhere" behavior);
// slot drops set both status and position.
export function useLaneDropTargets(
  laneId: TaskStatus,
  draggingId: string | null,
  callbacks: LaneDropCallbacks,
) {
  const [isOver, setIsOver] = useState(false);
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);

  function readIds(e: DragEvent): string[] {
    const raw = e.dataTransfer.getData(DRAG_MIME) || e.dataTransfer.getData('text/plain');
    return parseDragPayload(raw);
  }

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

  function slotProps(idx: number): LaneSlotProps {
    return {
      onDragEnter: (e) => {
        if (!draggingId) return;
        e.preventDefault();
        e.stopPropagation();
        setHoverIndex(idx);
      },
      onDragOver: (e) => {
        if (!draggingId) return;
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = 'move';
        if (hoverIndex !== idx) setHoverIndex(idx);
      },
      onDrop: (e) => {
        e.preventDefault();
        e.stopPropagation();
        const ids = readIds(e);
        if (ids.length > 1) {
          callbacks.onMultiDropAt(ids, laneId, idx);
        } else if (ids.length === 1) {
          callbacks.onDropAt(ids[0], laneId, idx);
        }
        setIsOver(false);
        setHoverIndex(null);
      },
    };
  }

  return { isOver, hoverIndex, onDragOver, onDragLeave, onDrop, slotProps };
}
