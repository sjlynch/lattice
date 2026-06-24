import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';

import type { Size } from './floatingPanel/geometry';
import {
  useFloatingPanelEscape,
  useFloatingPanelState,
  usePanelDrag,
  usePanelResize,
} from './floatingPanel/hooks';
import { useFocusTrap } from '../hooks/useFocusTrap';

type Props = {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children: ReactNode;
  defaultSize?: Size;
  minSize?: Size;
  storageKey?: string;
};

export function FloatingPanel({
  open,
  onClose,
  title,
  children,
  defaultSize = { width: 720, height: 520 },
  minSize = { width: 380, height: 280 },
  storageKey,
}: Props) {
  const { pos, size, setPos, setSize } = useFloatingPanelState(open, defaultSize, storageKey);
  useFloatingPanelEscape(open, onClose);
  const dialogRef = useFocusTrap<HTMLDivElement>(open);

  const onTitleDown = usePanelDrag({ pos, size, setPos });
  const onResizeDown = usePanelResize({ pos, size, minSize, setSize });

  if (!open) return null;

  return createPortal(
    <div
      ref={dialogRef}
      className="floating-panel"
      role="dialog"
      aria-modal="true"
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
