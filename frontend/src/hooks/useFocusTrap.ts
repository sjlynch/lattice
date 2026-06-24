import { useEffect, useRef } from 'react';

// Elements that can receive keyboard focus. `:not([disabled])` /
// `[tabindex]:not([tabindex="-1"])` keep disabled and explicitly-removed
// controls out of the Tab cycle.
const FOCUSABLE_SELECTOR = [
  'a[href]',
  'area[href]',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'button:not([disabled])',
  'iframe',
  'object',
  'embed',
  '[contenteditable]:not([contenteditable="false"])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

function getFocusable(container: HTMLElement): HTMLElement[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
    // getClientRects() is empty for `display:none` / detached nodes, so this
    // also drops the inactive content a tabbed dialog keeps mounted.
  ).filter((el) => el.getClientRects().length > 0);
}

/**
 * Shared focus management for modal/dialog wrappers. Attach the returned ref to
 * the dialog container. While `open`:
 *  1. focus moves to the first interactive element (unless something inside
 *     already has focus — e.g. an input with `autoFocus`);
 *  2. Tab / Shift+Tab wrap within the container instead of escaping to the
 *     background;
 *  3. on close, focus returns to whatever was focused before the dialog opened.
 *
 * Escape-to-close is intentionally left to each wrapper's own handler.
 */
export function useFocusTrap<T extends HTMLElement = HTMLElement>(open: boolean) {
  const containerRef = useRef<T | null>(null);
  // The element to return focus to on close. Captured during the render that
  // flips `open` true — before the commit phase runs any child `autoFocus` and
  // moves focus into the dialog (which would otherwise hide the real opener).
  const restoreRef = useRef<HTMLElement | null>(null);
  const wasOpen = useRef(false);
  if (open && !wasOpen.current) {
    restoreRef.current = document.activeElement as HTMLElement | null;
  }
  wasOpen.current = open;

  useEffect(() => {
    if (!open) return;
    const container = containerRef.current;
    if (!container) return;

    // Pull focus into the dialog, unless a child already grabbed it (autoFocus).
    if (!container.contains(document.activeElement)) {
      const focusable = getFocusable(container);
      if (focusable.length > 0) focusable[0].focus();
    }

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      const focusable = getFocusable(container);
      if (focusable.length === 0) {
        e.preventDefault();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (e.shiftKey) {
        if (active === first || !container.contains(active)) {
          e.preventDefault();
          last.focus();
        }
      } else if (active === last || !container.contains(active)) {
        e.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      // Restore focus to the opener. Guarded so a removed element (or one that
      // can't take focus) is skipped silently.
      const toRestore = restoreRef.current;
      if (toRestore && document.contains(toRestore) && typeof toRestore.focus === 'function') {
        toRestore.focus();
      }
    };
  }, [open]);

  return containerRef;
}
