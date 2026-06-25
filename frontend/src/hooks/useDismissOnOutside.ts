import { useEffect, useRef, type RefObject } from 'react';

/**
 * Dismiss-on-outside-click + Escape for a popover/menu. While `open`:
 *  1. a document `pointerdown` closes it when the click falls outside `ref`'s
 *     element;
 *  2. a window `keydown` closes it on Escape;
 * both listeners are torn down on close/unmount. `onClose` is read through a
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

  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: PointerEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onCloseRef.current();
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onCloseRef.current();
    }
    document.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open, ref]);
}
