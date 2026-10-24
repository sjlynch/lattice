import {
  useCallback,
  useLayoutEffect,
  useRef,
  type Dispatch,
  type MouseEvent as ReactMouseEvent,
  type SetStateAction,
} from 'react';

import { clampPos, VIEWPORT_PAD, type Pos, type Size } from './geometry';
import { isOutsideViewport } from './popoutGeometry';
import { useDocumentDragGesture } from './useDocumentDragGesture';
import type { PanelGeometry } from './usePanelGeometry';

// How far past the window's edge the pointer must go to arm a pop-out.
const POPOUT_ARM_MARGIN = 24;

type PanelDragState = {
  startX: number;
  startY: number;
  startPosX: number;
  startPosY: number;
  size: Size;
  /** The pointer is past the main window's edge (the panel stays clamped). */
  outside: boolean;
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
  /** The pointer crossed the main window's edge mid-drag (either way). */
  onOutsideChange?: (outside: boolean) => void;
  /**
   * The drag was released with the pointer outside the main window: `screen`
   * is the release point, `grab` the pointer's offset inside the panel.
   */
  onDropOutside?: (screen: Pos, grab: Pos) => void;
};

export function usePanelDrag({
  pos,
  size,
  setPos,
  noDragSelector = '.fp-no-drag',
  onOutsideChange,
  onDropOutside,
}: PanelDragOptions) {
  const latestGeometryRef = useRef<PanelGeometry>({ pos, size });
  useLayoutEffect(() => {
    latestGeometryRef.current = { pos, size };
  }, [pos, size]);
  const callbacksRef = useRef({ onOutsideChange, onDropOutside });
  useLayoutEffect(() => {
    callbacksRef.current = { onOutsideChange, onDropOutside };
  }, [onOutsideChange, onDropOutside]);

  const { start } = useDocumentDragGesture<PanelDragState>(
    useCallback(
      (state, moveEvent) => {
        const outside = isOutsideViewport(
          moveEvent.clientX,
          moveEvent.clientY,
          { width: window.innerWidth, height: window.innerHeight },
          POPOUT_ARM_MARGIN,
        );
        if (outside !== state.outside) {
          state.outside = outside;
          callbacksRef.current.onOutsideChange?.(outside);
        }
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
    useCallback((state: PanelDragState, upEvent: MouseEvent) => {
      if (!state.outside) return;
      callbacksRef.current.onOutsideChange?.(false);
      callbacksRef.current.onDropOutside?.(
        { x: upEvent.screenX, y: upEvent.screenY },
        { x: state.startX - state.startPosX, y: state.startY - state.startPosY },
      );
    }, []),
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
        outside: false,
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
