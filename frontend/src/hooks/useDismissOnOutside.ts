import { useEffect, useRef, type RefObject } from 'react';
import { usePanelDocument } from './usePanelDocument';

/**
 * Dismiss-on-outside-click + Escape for a popover/menu. While `open`:
 *  1. a document `pointerdown` closes it when the click falls outside `ref`'s
 *     element;
 *  2. a window `keydown` closes it on Escape;
 * both listeners are torn down on close/unmount. Inside a popped-out panel
 * they attach to the pop-out's document / window (`usePanelDocument`).
 * `onClose` is read through a
 * ref so changing its identity never re-attaches the listeners — the effect
 * re-runs only when `open` flips, matching the hand-rolled effects this
 * replaced.
 */
export function useDismissOnOutside<T extends HTMLElement = HTMLElement>(
  open: boolean,
  ref: RefObject<T | null>,
  onClose: () => void,
) {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const doc = usePanelDocument();

  useEffect(() => {
    if (!open) return;
    const win = doc.defaultView ?? window;
    function onPointerDown(e: PointerEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onCloseRef.current();
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onCloseRef.current();
    }
    doc.addEventListener('pointerdown', onPointerDown);
    win.addEventListener('keydown', onKey);
    return () => {
      doc.removeEventListener('pointerdown', onPointerDown);
      win.removeEventListener('keydown', onKey);
    };
  }, [open, ref, doc]);
}
