import { useEffect, useRef } from 'react';

// Innermost-wins Escape-to-close for stacked dialogs/overlays.
//
// Every layer that closes on Escape used to add its own bubble-phase `window`
// keydown listener (task detail / new-task overlays, `Modal`, `FloatingPanel`),
// and nothing stopped propagation — so one Escape inside the task editor closed
// the overlay AND the whole board panel behind it. Capture + `stopPropagation`
// alone can't fix a stack of two `window` listeners either (same target, so
// both still fire, in registration order). This hook keeps a module-level stack
// of open layers; only the top one handles the key. It registers in the capture
// phase and stops propagation so a bubble-phase listener further out (the
// FloatingPanel's `useFloatingPanelEscape`) never sees the event.
//
// The stack order is mount order, which for these layers is nesting order (a
// confirm dialog opens over the overlay that asked for it). `onClose` is read
// through a ref so a new callback identity doesn't re-push the layer on top.
const openLayers: symbol[] = [];

export function useEscapeToClose(open: boolean, onClose: () => void): void {
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!open) return;
    const token = Symbol('escape-layer');
    openLayers.push(token);
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (openLayers[openLayers.length - 1] !== token) return;
      e.stopPropagation();
      onCloseRef.current();
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      const i = openLayers.indexOf(token);
      if (i >= 0) openLayers.splice(i, 1);
    };
  }, [open]);
}
