import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';

type Size = { width: number; height: number };
type Pos = { x: number; y: number };

type Props = {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children: ReactNode;
  defaultSize?: Size;
  minSize?: Size;
  storageKey?: string;
};

const VIEWPORT_PAD = 12;

function clampPos(p: Pos, size: Size): Pos {
  const w = window.innerWidth;
  const h = window.innerHeight;
  return {
    x: Math.min(Math.max(VIEWPORT_PAD, p.x), w - size.width - VIEWPORT_PAD),
    y: Math.min(Math.max(VIEWPORT_PAD, p.y), h - size.height - VIEWPORT_PAD),
  };
}

function loadPersisted(key?: string): { pos?: Pos; size?: Size } | null {
  if (!key) return null;
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function persist(key: string | undefined, pos: Pos, size: Size) {
  if (!key) return;
  try {
    localStorage.setItem(key, JSON.stringify({ pos, size }));
  } catch {
    // ignore quota
  }
}

export function FloatingPanel({
  open,
  onClose,
  title,
  children,
  defaultSize = { width: 720, height: 520 },
  minSize = { width: 380, height: 280 },
  storageKey,
}: Props) {
  const persisted = useRef(loadPersisted(storageKey));

  const [size, setSize] = useState<Size>(persisted.current?.size ?? defaultSize);
  const [pos, setPos] = useState<Pos>(() => {
    if (persisted.current?.pos) return persisted.current.pos;
    const initSize = persisted.current?.size ?? defaultSize;
    return {
      x: Math.max(VIEWPORT_PAD, (window.innerWidth - initSize.width) / 2),
      y: Math.max(VIEWPORT_PAD, (window.innerHeight - initSize.height) / 3),
    };
  });

  // re-clamp into viewport when it opens, in case the window was resized
  useLayoutEffect(() => {
    if (open) setPos((p) => clampPos(p, size));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // persist
  useEffect(() => {
    persist(storageKey, pos, size);
  }, [storageKey, pos, size]);

  // Esc to close
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const dragRef = useRef<{
    startX: number;
    startY: number;
    startPosX: number;
    startPosY: number;
  } | null>(null);

  const resizeRef = useRef<{
    startX: number;
    startY: number;
    startW: number;
    startH: number;
  } | null>(null);

  const onTitleDown = useCallback(
    (e: React.MouseEvent) => {
      if ((e.target as HTMLElement).closest('.fp-no-drag')) return;
      e.preventDefault();
      dragRef.current = {
        startX: e.clientX,
        startY: e.clientY,
        startPosX: pos.x,
        startPosY: pos.y,
      };
      function move(ev: MouseEvent) {
        if (!dragRef.current) return;
        setPos(
          clampPos(
            {
              x: dragRef.current.startPosX + (ev.clientX - dragRef.current.startX),
              y: dragRef.current.startPosY + (ev.clientY - dragRef.current.startY),
            },
            size,
          ),
        );
      }
      function up() {
        dragRef.current = null;
        document.removeEventListener('mousemove', move);
        document.removeEventListener('mouseup', up);
      }
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up);
    },
    [pos.x, pos.y, size],
  );

  const onResizeDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      resizeRef.current = {
        startX: e.clientX,
        startY: e.clientY,
        startW: size.width,
        startH: size.height,
      };
      function move(ev: MouseEvent) {
        if (!resizeRef.current) return;
        const dx = ev.clientX - resizeRef.current.startX;
        const dy = ev.clientY - resizeRef.current.startY;
        const maxW = window.innerWidth - pos.x - VIEWPORT_PAD;
        const maxH = window.innerHeight - pos.y - VIEWPORT_PAD;
        setSize({
          width: Math.min(maxW, Math.max(minSize.width, resizeRef.current.startW + dx)),
          height: Math.min(maxH, Math.max(minSize.height, resizeRef.current.startH + dy)),
        });
      }
      function up() {
        resizeRef.current = null;
        document.removeEventListener('mousemove', move);
        document.removeEventListener('mouseup', up);
      }
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up);
    },
    [size.width, size.height, pos.x, pos.y, minSize.width, minSize.height],
  );

  if (!open) return null;

  return createPortal(
    <div
      className="floating-panel"
      role="dialog"
      style={{
        left: pos.x,
        top: pos.y,
        width: size.width,
        height: size.height,
      }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className="floating-panel-titlebar" onMouseDown={onTitleDown}>
        <div className="floating-panel-title">{title}</div>
        <button
          className="icon-btn sm fp-no-drag"
          onClick={onClose}
          aria-label="Close"
          title="Close"
        >
          <X size={14} />
        </button>
      </div>
      <div className="floating-panel-body">{children}</div>
      <div
        className="floating-panel-resize"
        onMouseDown={onResizeDown}
        title="Resize"
        aria-label="Resize"
      />
    </div>,
    document.body,
  );
}
