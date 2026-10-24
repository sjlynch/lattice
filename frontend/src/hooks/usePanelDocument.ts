import { createContext, useContext } from 'react';

// The document + window a FloatingPanel's content currently lives in: the main
// window's, or its pop-out window's (`components/FloatingPanel.tsx`). The
// global `document` / `window` are ALWAYS the main window's, so panel code that
// touches the DOM directly — event listeners, portals, focus, the clipboard
// (it rejects from an unfocused document), timers and `ResizeObserver`s that
// must keep running while the main window is minimised — reads its host here.
// Outside any panel (or under node tests) both resolve to the globals.
export type PanelHost = { doc: Document; win: Window & typeof globalThis };

const PanelHostContext = createContext<PanelHost | null>(null);

export const PanelHostProvider = PanelHostContext.Provider;

/** `doc` with its own window (falls back to the main window for a detached doc). */
export function panelHostFor(doc: Document): PanelHost {
  return { doc, win: (doc.defaultView ?? window) as Window & typeof globalThis };
}

// Read lazily: node tests render panel components with no DOM globals, and
// only an effect that actually runs (as before this context) touches them.
const mainDocument = () => (typeof document === 'undefined' ? undefined : document) as Document;
const mainWindow = () =>
  (typeof window === 'undefined' ? undefined : window) as Window & typeof globalThis;

export function usePanelDocument(): Document {
  return useContext(PanelHostContext)?.doc ?? mainDocument();
}

export function usePanelWindow(): Window & typeof globalThis {
  return useContext(PanelHostContext)?.win ?? mainWindow();
}

/**
 * Cross-window `instanceof Element`: a popped-out panel's nodes are created by
 * the pop-out's document, so `node instanceof Element` (the main window's
 * constructor) is false for them. Duck-type on `closest` instead.
 */
export function isElementLike(target: unknown): target is Element {
  return (
    typeof target === 'object' &&
    target !== null &&
    typeof (target as { closest?: unknown }).closest === 'function'
  );
}
