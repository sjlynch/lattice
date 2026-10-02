import { useEffect, useRef } from 'react';

// Open FloatingPanels, in open order. Several can be open at once (Settings,
// the task board and Workflows have no backdrop), and each used to close on
// ANY window Escape — so one Escape in Settings also closed the board and the
// Workflows panel behind it. Now only one panel handles a given Escape.
const openPanels: HTMLElement[] = [];

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
) {
  // Read through a ref: a new onClose identity must not re-register the panel
  // (that would move it to the top of the open-order stack).
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!open) return;
    const panel = panelRef.current;
    if (!panel) return;
    openPanels.push(panel);
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      const owner = panelForEscape(
        event.target,
        openPanels,
        (t) => t === document.body || t === document || t === document.documentElement,
      );
      if (owner === panel) onCloseRef.current();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      const i = openPanels.indexOf(panel);
      if (i >= 0) openPanels.splice(i, 1);
    };
  }, [open, panelRef]);
}
