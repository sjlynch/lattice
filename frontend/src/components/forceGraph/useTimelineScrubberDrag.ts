import { useCallback, useEffect, useState } from 'react';
import type { PointerEvent as ReactPointerEvent, RefObject } from 'react';
import { useRefMirror } from './hooks/useRefMirror';
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

  // The drag effect reads these through refs so its deps are just the handle
  // and the geometry. Every `onChange` it emits re-renders the parent with a
  // new `left`/`right` (and usually a fresh `onChange`); if those were deps the
  // effect would re-run mid-drag, cancelling a pending coalesced RAF — a
  // `pointermove` landing between `emit()` and the commit was dropped, and the
  // following `pointerup` released one tick behind the cursor.
  const leftRef = useRefMirror(left);
  const rightRef = useRefMirror(right);
  const onChangeRef = useRefMirror(onChange);

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

    // Coalesce the per-pointermove onChange into at most one call per frame:
    // each move just stashes the latest clientX and schedules a single RAF.
    // onChange drives the visible commit range (which filters/recolors graph
    // nodes), so firing it ~60+/sec during a fast scrub is wasted graph CPU.
    let rafId: number | null = null;
    let latestClientX = 0;

    function emit() {
      const idx = indexFromClientX(latestClientX);
      const range = rangeForHandleMove(
        handle,
        idx,
        leftRef.current,
        rightRef.current,
      );
      onChangeRef.current(range.left, range.right);
    }

    function onFrame() {
      rafId = null;
      emit();
    }

    function onMove(e: PointerEvent) {
      latestClientX = e.clientX;
      if (rafId === null) rafId = requestAnimationFrame(onFrame);
    }

    function onUp() {
      // Never drop the final frame: if a coalesced move is still pending,
      // flush it synchronously so the released range is exact.
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
        rafId = null;
        emit();
      }
      setActiveHandle(null);
    }

    function onCancel() {
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
      setActiveHandle(null);
    }

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    return () => {
      if (rafId !== null) cancelAnimationFrame(rafId);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
    };
  }, [activeHandle, indexFromClientX, leftRef, onChangeRef, rightRef]);

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
