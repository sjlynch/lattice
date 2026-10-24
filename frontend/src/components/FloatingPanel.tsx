import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import {
  Maximize2,
  Minimize2,
  SquareArrowOutDownLeft,
  SquareArrowOutUpRight,
  X,
} from 'lucide-react';

import type { Pos, Size } from './floatingPanel/geometry';
import {
  useFloatingPanelEscape,
  useFloatingPanelState,
  usePanelDrag,
  usePanelResize,
} from './floatingPanel/hooks';
import { popoutAtPointer } from './floatingPanel/popoutGeometry';
import { usePopout } from './floatingPanel/usePopout';
import { ErrorToast } from './shared/ErrorToast';
import { useFocusTrap } from '../hooks/useFocusTrap';
import { isElementLike, panelHostFor, PanelHostProvider } from '../hooks/usePanelDocument';

type Props = {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children: ReactNode;
  defaultSize?: Size;
  minSize?: Size;
  storageKey?: string;
  defaultPosition?: { x: number; y: number };
};

// Attaches the panel's stable host element to `doc`'s body. Rendered BEFORE
// the portal, so its layout effect runs before any of the panel's own: the
// content is already in a live document when children measure.
function PanelHostMount({ hostEl, doc }: { hostEl: HTMLElement; doc: Document }) {
  useLayoutEffect(() => {
    const from = hostEl.ownerDocument;
    const active = hostEl.isConnected ? from.activeElement : null;
    const refocus = from !== doc && active && hostEl.contains(active) ? (active as HTMLElement) : null;
    doc.body.appendChild(hostEl); // moves it (adopting it) if it was elsewhere
    // Moving a node drops its focus; keep the caret where the user was.
    if (refocus && typeof refocus.focus === 'function') refocus.focus({ preventScroll: true });
  }, [hostEl, doc]);
  useLayoutEffect(() => () => hostEl.remove(), [hostEl]);
  return null;
}

export function FloatingPanel({
  open,
  onClose,
  title,
  children,
  defaultSize = { width: 720, height: 520 },
  minSize = { width: 380, height: 280 },
  storageKey,
  defaultPosition,
}: Props) {
  const { pos, size, setPos, setSize, maximized, toggleMaximize } = useFloatingPanelState(
    open,
    defaultSize,
    storageKey,
    defaultPosition,
  );
  // The panel renders into ONE element for its whole life, and pop-out /
  // return MOVE that element between documents — a portal into a different
  // container would remount the whole subtree and lose every child's state.
  const [hostEl] = useState(() => {
    const el = document.createElement('div');
    el.className = 'floating-panel-host';
    return el;
  });
  const panelGeometry = useMemo(() => ({ pos, size }), [pos, size]);
  const popout = usePopout({ open, storageKey, panelGeometry });
  const poppedOut = popout.host !== null;
  const mainHost = useMemo(() => panelHostFor(document), []);
  const host = popout.host ?? mainHost;

  // Non-modal: panels have no backdrop and can sit side by side, so Tab is left
  // to the browser (a trap here hijacked Tab from older panels and from the page
  // outside). Focus still moves in on open and back to the opener on close.
  const dialogRef = useFocusTrap<HTMLDivElement>(open, { trapTab: false });
  useFloatingPanelEscape(open, onClose, dialogRef, host.win);

  // Dragging the titlebar past the main window's edge arms a pop-out; letting
  // go out there opens it at the pointer. (The mousedown that started the
  // drag is the user gesture `window.open` needs.)
  const [popoutArmed, setPopoutArmed] = useState(false);
  const { popOut } = popout;
  const onDropOutside = useCallback(
    (screen: Pos, grab: Pos) => popOut(popoutAtPointer(screen, grab, size)),
    [popOut, size],
  );
  const onTitleDown = usePanelDrag({
    pos,
    size,
    setPos,
    onOutsideChange: setPopoutArmed,
    onDropOutside,
  });
  const onResizeDown = usePanelResize({ pos, size, minSize, setSize });

  // The pop-out window's title is the panel's title text.
  const titleRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!popout.host) return;
    const text = titleRef.current?.textContent?.replace(/\s+/g, ' ').trim();
    const next = text ? `${text} · Lattice` : 'Lattice';
    if (popout.host.doc.title !== next) popout.host.doc.title = next;
  });

  // Double-clicking the titlebar toggles maximize, matching the OS window
  // behavior. Ignore double-clicks on interactive titlebar controls
  // (search box, close/maximize buttons) which carry `.fp-no-drag`.
  const onTitleDoubleClick = (event: ReactMouseEvent) => {
    const target = event.target;
    if (isElementLike(target) && target.closest('.fp-no-drag')) return;
    toggleMaximize();
  };

  if (!open) return null;

  // Popped out, the panel fills its own window (CSS); maximized, it fills the
  // main window; otherwise it uses the dragged/resized geometry. Keeping the
  // restore geometry in `pos`/`size` means returning / restoring lands on the
  // exact prior position and dimensions.
  const panelStyle = poppedOut
    ? undefined
    : maximized
      ? { left: 0, top: 0, right: 0, bottom: 0, width: 'auto', height: 'auto' }
      : { left: pos.x, top: pos.y, width: size.width, height: size.height };
  const className = [
    'floating-panel',
    poppedOut ? 'popped-out' : maximized ? 'maximized' : '',
    popoutArmed && !poppedOut ? 'popout-armed' : '',
  ]
    .filter(Boolean)
    .join(' ');
  const movable = !poppedOut && !maximized;

  return (
    <>
      <PanelHostMount hostEl={hostEl} doc={host.doc} />
      {createPortal(
        <PanelHostProvider value={host}>
          <div
            ref={dialogRef}
            className={className}
            role="dialog"
            style={panelStyle}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div
              className="floating-panel-titlebar"
              onMouseDown={movable ? onTitleDown : undefined}
              onDoubleClick={poppedOut ? undefined : onTitleDoubleClick}
            >
              <div className="floating-panel-title" ref={titleRef}>
                {title}
              </div>
              <div className="floating-panel-titlebar-actions fp-no-drag">
                {poppedOut ? (
                  <button
                    className="icon-btn sm fp-no-drag"
                    onClick={popout.popIn}
                    aria-label="Return to main window"
                    title="Return to main window"
                  >
                    <SquareArrowOutDownLeft size={13} />
                  </button>
                ) : (
                  <>
                    <button
                      className="icon-btn sm fp-no-drag"
                      onClick={() => popOut()}
                      aria-label="Pop out into its own window"
                      title="Pop out into its own window (or drag it past the window's edge)"
                    >
                      <SquareArrowOutUpRight size={13} />
                    </button>
                    <button
                      className="icon-btn sm fp-no-drag"
                      onClick={toggleMaximize}
                      aria-label={maximized ? 'Restore' : 'Maximize'}
                      title={maximized ? 'Restore' : 'Maximize'}
                    >
                      {maximized ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
                    </button>
                  </>
                )}
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
            {movable && (
              <div
                className="floating-panel-resize"
                onMouseDown={onResizeDown}
                title="Resize"
                aria-label="Resize"
              />
            )}
            {popout.error && (
              <ErrorToast message={popout.error} onDismiss={popout.clearError} />
            )}
          </div>
        </PanelHostProvider>,
        hostEl,
      )}
    </>
  );
}
