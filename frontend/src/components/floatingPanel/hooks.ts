import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type Dispatch,
  type MouseEvent as ReactMouseEvent,
  type SetStateAction,
} from 'react';

import {
  clampPos,
  getInitialFloatingPanelPos,
  loadPersistedFloatingPanelGeometry,
  persistFloatingPanelGeometry,
  VIEWPORT_PAD,
  type Pos,
  type Size,
} from './geometry';

type PanelGeometry = {
  pos: Pos;
  size: Size;
};

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

type FloatingPanelState = PanelGeometry & {
  setPos: Dispatch<SetStateAction<Pos>>;
  setSize: Dispatch<SetStateAction<Size>>;
};

export function useFloatingPanelState(
  open: boolean,
  defaultSize: Size,
  storageKey?: string,
): FloatingPanelState {
  const [initialGeometry] = useState<PanelGeometry>(() => {
    const persisted = loadPersistedFloatingPanelGeometry(storageKey);
    const initialSize = persisted?.size ?? defaultSize;
    return {
      size: initialSize,
      pos: persisted?.pos ?? getInitialFloatingPanelPos(initialSize),
    };
  });
  const [size, setSize] = useState<Size>(initialGeometry.size);
  const [pos, setPos] = useState<Pos>(initialGeometry.pos);

  const latestSizeRef = useRef(size);
  useLayoutEffect(() => {
    latestSizeRef.current = size;
  }, [size]);

  useLayoutEffect(() => {
    if (open) setPos((currentPos) => clampPos(currentPos, latestSizeRef.current));
  }, [open]);

  useEffect(() => {
    persistFloatingPanelGeometry(storageKey, pos, size);
  }, [storageKey, pos, size]);

  return { pos, size, setPos, setSize };
}

export function useFloatingPanelEscape(open: boolean, onClose: () => void) {
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
}

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
  const dragRef = useRef<PanelDragState | null>(null);
  const latestGeometryRef = useRef<PanelGeometry>({ pos, size });
  useLayoutEffect(() => {
    latestGeometryRef.current = { pos, size };
  }, [pos, size]);

  const removeListenersRef = useRef<(() => void) | null>(null);
  const stopDragging = useCallback(() => {
    dragRef.current = null;
    removeListenersRef.current?.();
    removeListenersRef.current = null;
  }, []);

  useEffect(() => {
    return stopDragging;
  }, [stopDragging]);

  return useCallback(
    (event: ReactMouseEvent) => {
      const target = event.target;
      if (target instanceof Element && target.closest(noDragSelector)) return;

      event.preventDefault();
      stopDragging();

      const { pos: startPos, size: dragSize } = latestGeometryRef.current;
      dragRef.current = {
        startX: event.clientX,
        startY: event.clientY,
        startPosX: startPos.x,
        startPosY: startPos.y,
        size: dragSize,
      };

      function move(moveEvent: MouseEvent) {
        if (!dragRef.current) return;
        setPos(
          clampPos(
            {
              x: dragRef.current.startPosX + (moveEvent.clientX - dragRef.current.startX),
              y: dragRef.current.startPosY + (moveEvent.clientY - dragRef.current.startY),
            },
            dragRef.current.size,
          ),
        );
      }

      function up() {
        stopDragging();
      }

      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up);
      removeListenersRef.current = () => {
        document.removeEventListener('mousemove', move);
        document.removeEventListener('mouseup', up);
      };
    },
    [noDragSelector, setPos, stopDragging],
  );
}

type PanelResizeOptions = PanelGeometry & {
  minSize: Size;
  setSize: Dispatch<SetStateAction<Size>>;
};

export function usePanelResize({ pos, size, minSize, setSize }: PanelResizeOptions) {
  const resizeRef = useRef<PanelResizeState | null>(null);
  const latestGeometryRef = useRef<PanelGeometry & { minSize: Size }>({ pos, size, minSize });
  useLayoutEffect(() => {
    latestGeometryRef.current = { pos, size, minSize };
  }, [pos, size, minSize]);

  const removeListenersRef = useRef<(() => void) | null>(null);
  const stopResizing = useCallback(() => {
    resizeRef.current = null;
    removeListenersRef.current?.();
    removeListenersRef.current = null;
  }, []);

  useEffect(() => {
    return stopResizing;
  }, [stopResizing]);

  return useCallback(
    (event: ReactMouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      stopResizing();

      const { pos: startPos, size: startSize, minSize: startMinSize } = latestGeometryRef.current;
      resizeRef.current = {
        startX: event.clientX,
        startY: event.clientY,
        startW: startSize.width,
        startH: startSize.height,
        pos: startPos,
        minSize: startMinSize,
      };

      function move(moveEvent: MouseEvent) {
        if (!resizeRef.current) return;
        const dx = moveEvent.clientX - resizeRef.current.startX;
        const dy = moveEvent.clientY - resizeRef.current.startY;
        const maxW = window.innerWidth - resizeRef.current.pos.x - VIEWPORT_PAD;
        const maxH = window.innerHeight - resizeRef.current.pos.y - VIEWPORT_PAD;
        setSize({
          width: Math.min(
            maxW,
            Math.max(resizeRef.current.minSize.width, resizeRef.current.startW + dx),
          ),
          height: Math.min(
            maxH,
            Math.max(resizeRef.current.minSize.height, resizeRef.current.startH + dy),
          ),
        });
      }

      function up() {
        stopResizing();
      }

      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up);
      removeListenersRef.current = () => {
        document.removeEventListener('mousemove', move);
        document.removeEventListener('mouseup', up);
      };
    },
    [setSize, stopResizing],
  );
}
