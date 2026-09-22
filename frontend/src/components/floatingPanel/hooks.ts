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
  maximized: boolean;
  toggleMaximize: () => void;
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
  // Windows-style maximize toggle. While maximized the panel fills the window
  // (rendered via CSS in FloatingPanel); `pos`/`size` are left untouched so a
  // restore returns to the exact previous position and dimensions.
  const [maximized, setMaximized] = useState(false);
  const toggleMaximize = useCallback(() => setMaximized((m) => !m), []);

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

  return { pos, size, setPos, setSize, maximized, toggleMaximize };
}

// Open FloatingPanels, in open order. Several can be open at once (Settings,
// the task board and Workflows have no backdrop), and each used to close on
// ANY window Escape — so one Escape in Settings also closed the board and the
// Workflows panel behind it. Now only one panel handles a given Escape.
const openPanels: HTMLElement[] = [];

type EscapeTarget = { closest?: (selector: string) => unknown } | null;

// Which open panel an Escape belongs to: the panel the key was pressed in; or,
// when nothing is focused (target = body/document), the most recently opened
// panel; otherwise (focus in some other control outside every panel) none.
export function panelForEscape<P>(
  target: EventTarget | null,
  panels: readonly P[],
  isBody: (target: EventTarget | null) => boolean,
): P | null {
  const t = target as EscapeTarget;
  const inPanel = typeof t?.closest === 'function' ? t.closest('.floating-panel') : null;
  if (inPanel) return panels.includes(inPanel as P) ? (inPanel as P) : null;
  if (isBody(target)) return panels[panels.length - 1] ?? null;
  return null;
}

export function useFloatingPanelEscape(
  open: boolean,
  onClose: () => void,
  panelRef: { readonly current: HTMLElement | null },
) {
  // Read through a ref: a new onClose identity must not re-register the panel
  // (that would move it to the top of the open-order stack).
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!open) return;
    const panel = panelRef.current;
    if (!panel) return;
    openPanels.push(panel);
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      const owner = panelForEscape(
        event.target,
        openPanels,
        (t) => t === document.body || t === document || t === document.documentElement,
      );
      if (owner === panel) onCloseRef.current();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      const i = openPanels.indexOf(panel);
      if (i >= 0) openPanels.splice(i, 1);
    };
  }, [open, panelRef]);
}

/**
 * Owns the document mousemove/mouseup listener lifecycle for a pointer drag
 * gesture. A gesture snapshot of type `TState` is captured by `start(state)`
 * and handed to `onMove` on every mousemove; `stop` (also bound to mouseup and
 * to unmount cleanup) drops the snapshot and detaches the listeners. Callers
 * supply only the per-move math via `onMove`.
 */
function useDocumentDragGesture<TState>(onMove: (state: TState, event: MouseEvent) => void) {
  const stateRef = useRef<TState | null>(null);
  const removeListenersRef = useRef<(() => void) | null>(null);

  const stop = useCallback(() => {
    stateRef.current = null;
    removeListenersRef.current?.();
    removeListenersRef.current = null;
  }, []);

  useEffect(() => {
    return stop;
  }, [stop]);

  const start = useCallback(
    (state: TState) => {
      stop();
      stateRef.current = state;

      function move(moveEvent: MouseEvent) {
        if (!stateRef.current) return;
        onMove(stateRef.current, moveEvent);
      }

      function up() {
        stop();
      }

      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up);
      removeListenersRef.current = () => {
        document.removeEventListener('mousemove', move);
        document.removeEventListener('mouseup', up);
      };
    },
    [onMove, stop],
  );

  return { start, stop };
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
