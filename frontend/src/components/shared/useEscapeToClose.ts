import { useEffect, useRef } from 'react';
import { usePanelWindow } from '../../hooks/usePanelDocument';

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
//
// A layer inside a popped-out panel listens in the pop-out's window
// (`usePanelWindow`), and "the top layer" is the top one in the window the key
// was pressed in. Moving between windows re-targets the listener but keeps the
// layer's place in the stack.
type Layer = { win: Window | null };
const openLayers: Layer[] = [];

function topLayerIn(win: Window): Layer | undefined {
  for (let i = openLayers.length - 1; i >= 0; i--) {
    if (openLayers[i].win === win) return openLayers[i];
  }
  return undefined;
}

export function useEscapeToClose(open: boolean, onClose: () => void): void {
  const win = usePanelWindow();
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  const layerRef = useRef<Layer | null>(null);
  useEffect(() => {
    if (!open) return;
    const layer: Layer = { win: null };
    openLayers.push(layer);
    layerRef.current = layer;
    return () => {
      layerRef.current = null;
      const i = openLayers.indexOf(layer);
      if (i >= 0) openLayers.splice(i, 1);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const layer = layerRef.current;
    if (!layer) return;
    layer.win = win;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (topLayerIn(win) !== layer) return;
      e.stopPropagation();
      onCloseRef.current();
    };
    win.addEventListener('keydown', onKey, true);
    return () => {
      win.removeEventListener('keydown', onKey, true);
    };
  }, [open, win]);
}
