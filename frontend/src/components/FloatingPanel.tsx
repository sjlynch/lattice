import type { MouseEvent as ReactMouseEvent, ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Maximize2, Minimize2, X } from 'lucide-react';

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
  const { pos, size, setPos, setSize, maximized, toggleMaximize } = useFloatingPanelState(
    open,
    defaultSize,
    storageKey,
  );
  // Non-modal: panels have no backdrop and can sit side by side, so Tab is left
  // to the browser (a trap here hijacked Tab from older panels and from the page
  // outside). Focus still moves in on open and back to the opener on close.
  const dialogRef = useFocusTrap<HTMLDivElement>(open, { trapTab: false });
  useFloatingPanelEscape(open, onClose, dialogRef);

  const onTitleDown = usePanelDrag({ pos, size, setPos });
  const onResizeDown = usePanelResize({ pos, size, minSize, setSize });

  // Double-clicking the titlebar toggles maximize, matching the OS window
  // behavior. Ignore double-clicks on interactive titlebar controls
  // (search box, close/maximize buttons) which carry `.fp-no-drag`.
  const onTitleDoubleClick = (event: ReactMouseEvent) => {
    const target = event.target;
    if (target instanceof Element && target.closest('.fp-no-drag')) return;
    toggleMaximize();
  };

  if (!open) return null;

  // When maximized the panel fills the whole window; otherwise it uses the
  // dragged/resized geometry. Keeping the restore geometry in `pos`/`size`
  // means toggling back returns to the exact prior position and dimensions.
  const panelStyle = maximized
    ? { left: 0, top: 0, right: 0, bottom: 0, width: 'auto', height: 'auto' }
    : { left: pos.x, top: pos.y, width: size.width, height: size.height };

  return createPortal(
    <div
      ref={dialogRef}
      className={maximized ? 'floating-panel maximized' : 'floating-panel'}
      role="dialog"
      style={panelStyle}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div
        className="floating-panel-titlebar"
        onMouseDown={maximized ? undefined : onTitleDown}
        onDoubleClick={onTitleDoubleClick}
      >
        <div className="floating-panel-title">{title}</div>
        <div className="floating-panel-titlebar-actions fp-no-drag">
          <button
            className="icon-btn sm fp-no-drag"
            onClick={toggleMaximize}
            aria-label={maximized ? 'Restore' : 'Maximize'}
            title={maximized ? 'Restore' : 'Maximize'}
          >
            {maximized ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
          </button>
          <button
            className="icon-btn sm fp-no-drag"
            onClick={onClose}
            aria-label="Close"
            title="Close"
          >
            <X size={14} />
          </button>
        </div>
      </div>
      <div className="floating-panel-body">{children}</div>
      {!maximized && (
        <div
          className="floating-panel-resize"
          onMouseDown={onResizeDown}
          title="Resize"
          aria-label="Resize"
        />
      )}
    </div>,
    document.body,
  );
}
