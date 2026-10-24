import { type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useFocusTrap } from '../hooks/useFocusTrap';
import { usePanelDocument } from '../hooks/usePanelDocument';
import { useEscapeToClose } from './shared/useEscapeToClose';

type Props = {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  width?: number;
};

export function Modal({ open, onClose, children, width }: Props) {
  const dialogRef = useFocusTrap<HTMLDivElement>(open);
  // Into the body of the window the caller is in: a confirm asked from a
  // popped-out panel opens over that panel, not in the main window.
  const doc = usePanelDocument();

  // Innermost-wins: a Modal opened over an overlay/FloatingPanel (e.g. the
  // delete ConfirmDialog over the task editor) takes the Escape alone.
  useEscapeToClose(open, onClose);

  if (!open) return null;

  return createPortal(
    <div
      className="modal-backdrop"
      // Dismiss only when the press *starts* on the backdrop itself. Guarding on
      // mousedown (rather than a backdrop `onClick`) is what fixes text-selection
      // drags: a drag that begins inside the dialog and releases out on the
      // backdrop fires a `click` on the backdrop (the nearest common ancestor of
      // the mousedown/mouseup targets), which used to wrongly close the dialog.
      // With this, that press started inside, so it never dismisses. Matches the
      // taskboard overlays' pattern.
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className="modal"
        role="dialog"
        aria-modal="true"
        style={width ? { width } : undefined}
      >
        {children}
      </div>
    </div>,
    doc.body,
  );
}
