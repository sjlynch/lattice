import { useCallback, useEffect, useState } from 'react';
import type { PointerEvent as ReactPointerEvent, RefObject } from 'react';
import {
  rangeForHandleMove,
  rangeForTrackSelection,
  tickIndexFromClientX,
  type TimelineHandle,
} from './timelineRange';

type TimelineTrackRef = RefObject<HTMLElement | null>;

type UseTimelineScrubberDragResult = {
  activeHandle: TimelineHandle | null;
  indexFromClientX: (clientX: number) => number;
  startHandleDrag: (handle: TimelineHandle) => (e: ReactPointerEvent) => void;
  onTrackPointerDown: (e: ReactPointerEvent) => void;
};

export function useTimelineScrubberDrag(
  trackRef: TimelineTrackRef,
  left: number,
  right: number,
  tickCount: number,
  onChange: (left: number, right: number) => void,
): UseTimelineScrubberDragResult {
  const [activeHandle, setActiveHandle] = useState<TimelineHandle | null>(null);

  const indexFromClientX = useCallback(
    (clientX: number): number => {
      const rect = trackRef.current?.getBoundingClientRect();
      if (!rect) return 0;
      return tickIndexFromClientX(clientX, rect, tickCount);
    },
    [tickCount, trackRef],
  );

  useEffect(() => {
    if (!activeHandle) return;
    const handle = activeHandle;

    function onMove(e: PointerEvent) {
      const idx = indexFromClientX(e.clientX);
      const range = rangeForHandleMove(handle, idx, left, right);
      onChange(range.left, range.right);
    }

    function onUp() {
      setActiveHandle(null);
    }

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
  }, [activeHandle, indexFromClientX, left, onChange, right]);

  const startHandleDrag = useCallback(
    (handle: TimelineHandle) => (e: ReactPointerEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setActiveHandle(handle);
    },
    [],
  );

  const onTrackPointerDown = useCallback(
    (e: ReactPointerEvent) => {
      if (activeHandle) return;
      const idx = indexFromClientX(e.clientX);
      const { handle, range } = rangeForTrackSelection(idx, left, right);
      onChange(range.left, range.right);
      setActiveHandle(handle);
    },
    [activeHandle, indexFromClientX, left, onChange, right],
  );

  return {
    activeHandle,
    indexFromClientX,
    startHandleDrag,
    onTrackPointerDown,
  };
}
