import { useEffect, useRef } from 'react';

// Open FloatingPanels, in open order. Several can be open at once (Settings,
// the task board and Workflows have no backdrop), and each used to close on
// ANY window Escape — so one Escape in Settings also closed the board and the
// Workflows panel behind it. Now only one panel handles a given Escape.
//
// Each entry also records the window the panel is in now: the main window, or
// its pop-out (`usePopout`). A key pressed in one window only ever concerns
// the panels in that window, and moving a panel between windows keeps its
// place in the open order.
type OpenPanel = { el: HTMLElement; win: Window | null };
const openPanels: OpenPanel[] = [];

type EscapeTarget = { closest?: (selector: string) => unknown } | null;

// Which open panel an Escape belongs to: the panel the key was pressed in; or,
// when nothing is focused (target = body/document), the most recently opened
// panel; otherwise (focus in some other control outside every panel) none.
export function panelForEscape<P>(
  target: EventTarget | null,
  panels: readonly P[],
  isBody: (target: EventTarget | null) => boolean,
): P | null {
  const t = target as EscapeTarget;
  const inPanel = typeof t?.closest === 'function' ? t.closest('.floating-panel') : null;
  if (inPanel) return panels.includes(inPanel as P) ? (inPanel as P) : null;
  if (isBody(target)) return panels[panels.length - 1] ?? null;
  return null;
}

export function useFloatingPanelEscape(
  open: boolean,
  onClose: () => void,
  panelRef: { readonly current: HTMLElement | null },
  /** The window the panel is in now (its pop-out's, when popped out). */
  win: Window = window,
) {
  // Read through a ref: a new onClose identity must not re-register the panel
  // (that would move it to the top of the open-order stack).
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  // Join the open-order stack once per open; a move between windows below
  // only re-targets the listener.
  const entryRef = useRef<OpenPanel | null>(null);
  useEffect(() => {
    if (!open) return;
    const el = panelRef.current;
    if (!el) return;
    const entry: OpenPanel = { el, win: null };
    openPanels.push(entry);
    entryRef.current = entry;
    return () => {
      entryRef.current = null;
      const i = openPanels.indexOf(entry);
      if (i >= 0) openPanels.splice(i, 1);
    };
  }, [open, panelRef]);

  useEffect(() => {
    if (!open) return;
    const entry = entryRef.current;
    if (!entry) return;
    entry.win = win;
    const doc = win.document;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      const inThisWindow = openPanels.filter((p) => p.win === win).map((p) => p.el);
      const owner = panelForEscape(
        event.target,
        inThisWindow,
        (t) => t === doc.body || t === doc || t === doc.documentElement,
      );
      if (owner === entry.el) onCloseRef.current();
    };
    win.addEventListener('keydown', onKey);
    return () => win.removeEventListener('keydown', onKey);
  }, [open, win]);
}
