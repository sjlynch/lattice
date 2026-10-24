import { registerMemGauge } from '../../debug/memDiag';

// Every open FloatingPanel pop-out window (`usePopout`). Module-level so the
// pieces that are not inside any panel can still see them:
//  - the main window closing / reloading closes every pop-out (they would be
//    orphaned: their React tree lives in this window);
//  - polling that pauses while "the page" is hidden asks `isLatticeHidden()`,
//    which is false while ANY Lattice window is visible — a board popped out on
//    a second monitor keeps updating with the main window minimised;
//  - `interactionDocument()` names the window the user last clicked / typed in,
//    so a confirm asked from a popped-out panel opens where the user is.

type Entry = { win: Window; beforeClose?: () => void };

const popouts = new Set<Entry>();
const subscribers = new Set<() => void>();
let lastInteraction: Document | null = null;
let mainHooked: (() => void) | null = null;

registerMemGauge('floatingPanel.popouts', () => popouts.size);
registerMemGauge('floatingPanel.popoutSubscribers', () => subscribers.size);

function notify(): void {
  for (const fn of [...subscribers]) fn();
}

function isClosed(win: Window): boolean {
  try {
    return win.closed;
  } catch {
    return true;
  }
}

/** Close every open pop-out, letting each save its geometry first. */
export function closeAllPopouts(): void {
  for (const entry of [...popouts]) {
    try {
      entry.beforeClose?.();
    } catch {
      /* a failed save must not keep the window open */
    }
    try {
      if (!isClosed(entry.win)) entry.win.close();
    } catch {
      /* already gone */
    }
  }
}

// Main-window listeners exist only while a pop-out does.
function hookMain(): void {
  if (mainHooked) return;
  const onInteract = () => {
    lastInteraction = document;
  };
  const onPageHide = () => closeAllPopouts();
  document.addEventListener('pointerdown', onInteract, true);
  document.addEventListener('keydown', onInteract, true);
  window.addEventListener('pagehide', onPageHide);
  mainHooked = () => {
    document.removeEventListener('pointerdown', onInteract, true);
    document.removeEventListener('keydown', onInteract, true);
    window.removeEventListener('pagehide', onPageHide);
  };
}

/**
 * Track `win` as an open pop-out until the returned unregister runs.
 * `beforeClose` runs when the main window closes them all (geometry save).
 */
export function registerPopout(win: Window, beforeClose?: () => void): () => void {
  hookMain();
  const entry: Entry = { win, beforeClose };
  const doc = win.document;
  const onInteract = () => {
    lastInteraction = doc;
  };
  doc.addEventListener('pointerdown', onInteract, true);
  doc.addEventListener('keydown', onInteract, true);
  popouts.add(entry);
  lastInteraction = doc;
  notify();
  return () => {
    if (!popouts.delete(entry)) return;
    try {
      doc.removeEventListener('pointerdown', onInteract, true);
      doc.removeEventListener('keydown', onInteract, true);
    } catch {
      /* the window is gone */
    }
    if (lastInteraction === doc) lastInteraction = null;
    if (popouts.size === 0) {
      mainHooked?.();
      mainHooked = null;
    }
    notify();
  };
}

/** Called whenever a pop-out opens or closes. */
export function subscribePopouts(fn: () => void): () => void {
  subscribers.add(fn);
  return () => {
    subscribers.delete(fn);
  };
}

/** Documents of the pop-outs that are still open. */
export function popoutDocuments(): Document[] {
  const out: Document[] = [];
  for (const { win } of popouts) {
    if (isClosed(win)) continue;
    try {
      out.push(win.document);
    } catch {
      /* navigated away / cross-origin */
    }
  }
  return out;
}

export function isOpenPopoutDocument(doc: Document): boolean {
  return popoutDocuments().includes(doc);
}

/**
 * Call `cb` once when the pop-out showing `doc` closes (never for the main
 * document). For a dialog asked in a pop-out, so it can move to the main
 * window instead of leaving its awaiter hanging.
 */
export function onPopoutDocumentClosed(doc: Document, cb: () => void): () => void {
  if (doc === document) return () => {};
  let done = false;
  const unsubscribe = subscribePopouts(() => {
    if (done || isOpenPopoutDocument(doc)) return;
    done = true;
    unsubscribe();
    cb();
  });
  return unsubscribe;
}

/** The Lattice window the user last pressed a pointer or key in. */
export function interactionDocument(): Document {
  if (lastInteraction && lastInteraction !== document && isOpenPopoutDocument(lastInteraction)) {
    return lastInteraction;
  }
  return document;
}

function hidden(doc: Document): boolean {
  try {
    return doc.visibilityState === 'hidden';
  } catch {
    return true;
  }
}

/** True only when the main window AND every pop-out are hidden. */
export function isLatticeHidden(): boolean {
  if (!hidden(document)) return false;
  return popoutDocuments().every(hidden);
}

/**
 * Call `cb` whenever `isLatticeHidden()` flips — on a `visibilitychange` of
 * any Lattice window, or a pop-out opening / closing. The drop-in for a
 * `document` `visibilitychange` listener in polling that should keep running
 * while any Lattice window is visible.
 */
export function onLatticeVisibilityChange(cb: () => void): () => void {
  let last = isLatticeHidden();
  const check = () => {
    const now = isLatticeHidden();
    if (now === last) return;
    last = now;
    cb();
  };
  let attached: Document[] = [];
  const attach = () => {
    const next = [document, ...popoutDocuments()];
    for (const doc of attached) {
      if (next.includes(doc)) continue;
      try {
        doc.removeEventListener('visibilitychange', check);
      } catch {
        /* the window is gone */
      }
    }
    for (const doc of next) if (!attached.includes(doc)) doc.addEventListener('visibilitychange', check);
    attached = next;
  };
  attach();
  const unsubscribe = subscribePopouts(() => {
    attach();
    check();
  });
  return () => {
    unsubscribe();
    for (const doc of attached) {
      try {
        doc.removeEventListener('visibilitychange', check);
      } catch {
        /* the window is gone */
      }
    }
    attached = [];
  };
}
