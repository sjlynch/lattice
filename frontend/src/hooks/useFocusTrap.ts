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

// Innermost-wins stack of open traps, in open (= nesting) order. `Modal` and
// `FloatingPanel` both portal to `document.body`, so a confirm dialog over a
// panel is a SIBLING tree: with every trap handling Tab, the panel's listener
// (registered first) pulled focus into the panel, then the modal's pulled it
// back to its first control — so Tab from the modal's last button always landed
// on the first one and the middle ones were unreachable by keyboard. Only the
// top trap acts; mirrors `components/shared/useEscapeToClose`. (FloatingPanel
// is now non-modal — `trapTab: false` — and never joins this stack; the same
// sibling-portal problem applies to any two trapping dialogs.)
const openTraps: symbol[] = [];

export function pushFocusTrap(token: symbol): void {
  openTraps.push(token);
}

export function removeFocusTrap(token: symbol): void {
  const i = openTraps.indexOf(token);
  if (i >= 0) openTraps.splice(i, 1);
}

export function isTopFocusTrap(token: symbol): boolean {
  return openTraps[openTraps.length - 1] === token;
}

export type FocusTrapOptions = {
  /**
   * Wrap Tab / Shift+Tab within the container (default `true`). `false` is for
   * NON-modal surfaces (`FloatingPanel`): focus still moves in on open and back
   * to the opener on close, but Tab is left to the browser and the surface is
   * never pushed on the trap stack — so it can neither steal Tab from a modal
   * nor count as the "top trap" that preempts one.
   */
  trapTab?: boolean;
};

/**
 * The non-React core of `useFocusTrap`: activate focus management on
 * `container` and return the cleanup (which restores focus to `restoreTo`).
 * Exported for tests.
 */
export function activateFocusScope(
  container: HTMLElement,
  restoreTo: HTMLElement | null,
  options: FocusTrapOptions = {},
): () => void {
  const trapTab = options.trapTab ?? true;

  // Pull focus into the dialog, unless a child already grabbed it (autoFocus).
  if (!container.contains(document.activeElement)) {
    const focusable = getFocusable(container);
    if (focusable.length > 0) focusable[0].focus();
  }

  const restore = () => {
    // Restore focus to the opener. Guarded so a removed element (or one that
    // can't take focus) is skipped silently.
    if (restoreTo && document.contains(restoreTo) && typeof restoreTo.focus === 'function') {
      restoreTo.focus();
    }
  };

  if (!trapTab) return restore;

  const token = Symbol('focus-trap');
  pushFocusTrap(token);

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== 'Tab') return;
    // A dialog stacked over this one owns the Tab cycle.
    if (!isTopFocusTrap(token)) return;
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
    removeFocusTrap(token);
    restore();
  };
}

/**
 * Shared focus management for modal/dialog wrappers. Attach the returned ref to
 * the dialog container. While `open`:
 *  1. focus moves to the first interactive element (unless something inside
 *     already has focus — e.g. an input with `autoFocus`);
 *  2. Tab / Shift+Tab wrap within the container instead of escaping to the
 *     background (skipped with `{ trapTab: false }` — see `FocusTrapOptions`);
 *  3. on close, focus returns to whatever was focused before the dialog opened.
 *
 * Escape-to-close is intentionally left to each wrapper's own handler.
 */
export function useFocusTrap<T extends HTMLElement = HTMLElement>(
  open: boolean,
  options: FocusTrapOptions = {},
) {
  const trapTab = options.trapTab ?? true;
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
    return activateFocusScope(container, restoreRef.current, { trapTab });
  }, [open, trapTab]);

  return containerRef;
}
