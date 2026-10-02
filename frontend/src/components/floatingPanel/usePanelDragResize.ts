import {
  useCallback,
  useLayoutEffect,
  useRef,
  type Dispatch,
  type MouseEvent as ReactMouseEvent,
  type SetStateAction,
} from 'react';

import { clampPos, VIEWPORT_PAD, type Pos, type Size } from './geometry';
import { useDocumentDragGesture } from './useDocumentDragGesture';
import type { PanelGeometry } from './usePanelGeometry';

type PanelDragState = {
  startX: number;
  startY: number;
  startPosX: number;
  startPosY: number;
  size: Size;
};

type PanelResizeState = {
  startX: number;
  startY: number;
  startW: number;
  startH: number;
  pos: Pos;
  minSize: Size;
};

type PanelDragOptions = PanelGeometry & {
  setPos: Dispatch<SetStateAction<Pos>>;
  noDragSelector?: string;
};

export function usePanelDrag({
  pos,
  size,
  setPos,
  noDragSelector = '.fp-no-drag',
}: PanelDragOptions) {
  const latestGeometryRef = useRef<PanelGeometry>({ pos, size });
  useLayoutEffect(() => {
    latestGeometryRef.current = { pos, size };
  }, [pos, size]);

  const { start } = useDocumentDragGesture<PanelDragState>(
    useCallback(
      (state, moveEvent) => {
        setPos(
          clampPos(
            {
              x: state.startPosX + (moveEvent.clientX - state.startX),
              y: state.startPosY + (moveEvent.clientY - state.startY),
            },
            state.size,
          ),
        );
      },
      [setPos],
    ),
  );

  return useCallback(
    (event: ReactMouseEvent) => {
      const target = event.target;
      if (target instanceof Element && target.closest(noDragSelector)) return;

      event.preventDefault();

      const { pos: startPos, size: dragSize } = latestGeometryRef.current;
      start({
        startX: event.clientX,
        startY: event.clientY,
        startPosX: startPos.x,
        startPosY: startPos.y,
        size: dragSize,
      });
    },
    [noDragSelector, start],
  );
}

type PanelResizeOptions = PanelGeometry & {
  minSize: Size;
  setSize: Dispatch<SetStateAction<Size>>;
};

export function usePanelResize({ pos, size, minSize, setSize }: PanelResizeOptions) {
  const latestGeometryRef = useRef<PanelGeometry & { minSize: Size }>({ pos, size, minSize });
  useLayoutEffect(() => {
    latestGeometryRef.current = { pos, size, minSize };
  }, [pos, size, minSize]);

  const { start } = useDocumentDragGesture<PanelResizeState>(
    useCallback(
      (state, moveEvent) => {
        const dx = moveEvent.clientX - state.startX;
        const dy = moveEvent.clientY - state.startY;
        const maxW = window.innerWidth - state.pos.x - VIEWPORT_PAD;
        const maxH = window.innerHeight - state.pos.y - VIEWPORT_PAD;
        setSize({
          width: Math.min(maxW, Math.max(state.minSize.width, state.startW + dx)),
          height: Math.min(maxH, Math.max(state.minSize.height, state.startH + dy)),
        });
      },
      [setSize],
    ),
  );

  return useCallback(
    (event: ReactMouseEvent) => {
      event.preventDefault();
      event.stopPropagation();

      const { pos: startPos, size: startSize, minSize: startMinSize } = latestGeometryRef.current;
      start({
        startX: event.clientX,
        startY: event.clientY,
        startW: startSize.width,
        startH: startSize.height,
        pos: startPos,
        minSize: startMinSize,
      });
    },
    [start],
  );
}
