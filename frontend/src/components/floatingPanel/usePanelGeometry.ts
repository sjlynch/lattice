import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from 'react';

import {
  clampPos,
  getInitialFloatingPanelPos,
  loadPersistedFloatingPanelGeometry,
  persistFloatingPanelGeometry,
  type Pos,
  type Size,
} from './geometry';

export type PanelGeometry = {
  pos: Pos;
  size: Size;
};

type FloatingPanelState = PanelGeometry & {
  setPos: Dispatch<SetStateAction<Pos>>;
  setSize: Dispatch<SetStateAction<Size>>;
  maximized: boolean;
  toggleMaximize: () => void;
};

type FrameScheduler = {
  request: (callback: () => void) => number;
  cancel: (handle: number) => void;
};

const animationFrames: FrameScheduler = {
  request: (callback) => requestAnimationFrame(callback),
  cancel: (handle) => cancelAnimationFrame(handle),
};

/**
 * Coalesces geometry persistence. Drag and resize change `pos`/`size` on every
 * mousemove, and a synchronous localStorage write per move is wasted work, so
 * each key's latest geometry is queued and written at most once per animation
 * frame. `flush` writes whatever is queued right now; callers flush wherever
 * the stored value must already be current (before a read, on unmount, on
 * pagehide), so what ends up stored is exactly what a write per change left.
 */
export function createGeometryWriteQueue(
  write: (storageKey: string, pos: Pos, size: Size) => void,
  frames: FrameScheduler,
) {
  const pending = new Map<string, PanelGeometry>();
  let frame: number | null = null;

  function flush() {
    if (frame !== null) {
      frames.cancel(frame);
      frame = null;
    }
    const writes = [...pending];
    pending.clear();
    for (const [storageKey, { pos, size }] of writes) write(storageKey, pos, size);
  }

  function schedule(storageKey: string | undefined, pos: Pos, size: Size) {
    if (!storageKey) return;
    pending.set(storageKey, { pos, size });
    if (frame !== null) return;
    frame = frames.request(() => {
      frame = null;
      flush();
    });
  }

  return { schedule, flush };
}

const geometryWrites = createGeometryWriteQueue(persistFloatingPanelGeometry, animationFrames);

export function useFloatingPanelState(
  open: boolean,
  defaultSize: Size,
  storageKey?: string,
): FloatingPanelState {
  const [initialGeometry] = useState<PanelGeometry>(() => {
    // A panel that unmounted in this same commit may still have this key's
    // last geometry queued; land it before reading.
    geometryWrites.flush();
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
    geometryWrites.schedule(storageKey, pos, size);
  }, [storageKey, pos, size]);

  // Unmount, or a reload / tab close mid-drag, must not wait for a frame that
  // may never come. A per-panel listener: the shared `flush` registered by
  // several panels would be deduped, and the first unmount would remove it.
  useEffect(() => {
    const onPageHide = () => geometryWrites.flush();
    window.addEventListener('pagehide', onPageHide);
    return () => {
      window.removeEventListener('pagehide', onPageHide);
      geometryWrites.flush();
    };
  }, []);

  return { pos, size, setPos, setSize, maximized, toggleMaximize };
}
