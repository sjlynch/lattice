import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

import { panelHostFor, type PanelHost } from '../../hooks/usePanelDocument';
import {
  initialPopoutGeometry,
  loadPopoutGeometry,
  popoutFeatures,
  popoutStorageKey,
  readPopoutGeometry,
  savePopoutGeometry,
  type PopoutGeometry,
} from './popoutGeometry';
import { registerPopout } from './popoutRegistry';
import { mirrorDocumentStyles } from './popoutStyles';
import type { PanelGeometry } from './usePanelGeometry';

export const POPOUT_BLOCKED_MESSAGE =
  'The browser blocked the pop-out window. Allow pop-ups for this site (the blocked pop-up ' +
  'icon at the right of the address bar), then click Pop out again.';
const POPOUT_FAILED_MESSAGE = 'The pop-out window did not finish loading, so the panel stayed here.';

// A same-origin blank page (`frontend/public/popout.html`), not about:blank:
// the initial about:blank document renders in quirks mode, and
// document.write()-ing a doctype into it gives the pop-out the MAIN app's URL
// (F5 there would boot a second Lattice inside the popup).
const POPOUT_FILE = 'popout.html';
const READY_POLL_MS = 25;
const READY_TIMEOUT_MS = 10_000;

function popoutUrl(): string {
  return `${import.meta.env?.BASE_URL ?? '/'}${POPOUT_FILE}`;
}

// Per page load: a second Lattice tab popping out the same panel must get its
// own window, never re-target (navigate) this tab's.
const PAGE_ID = Math.random().toString(36).slice(2, 10);

function windowName(storageKey: string | undefined): string {
  return `lattice-popout-${PAGE_ID}-${(storageKey ?? 'panel').replace(/[^\w.-]/g, '_')}`;
}

function isClosed(win: Window): boolean {
  try {
    return win.closed;
  } catch {
    return true;
  }
}

/** Poll until `win` has loaded the blank pop-out page (or is gone). */
function whenPopoutReady(win: Window, onReady: () => void, onFail: () => void): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const deadline = Date.now() + READY_TIMEOUT_MS;
  const check = () => {
    timer = null;
    let ready = false;
    try {
      if (isClosed(win)) return onFail();
      const doc = win.document;
      ready =
        doc.readyState === 'complete' && !!doc.body && win.location.pathname.endsWith(POPOUT_FILE);
    } catch {
      return onFail(); // navigated somewhere this window can't reach
    }
    if (ready) return onReady();
    if (Date.now() > deadline) return onFail();
    timer = setTimeout(check, READY_POLL_MS);
  };
  timer = setTimeout(check, 0);
  return () => {
    if (timer !== null) clearTimeout(timer);
  };
}

type Options = {
  open: boolean;
  /** The panel's `lattice.<thing>.window` key; the pop-out persists beside it. */
  storageKey?: string;
  /** The panel's current in-window geometry (first pop-out opens over it). */
  panelGeometry: PanelGeometry;
};

/**
 * One panel's pop-out window. `host` is the pop-out's document/window while it
 * is open (null = the panel lives in the main window). `popOut` must run in a
 * user gesture (a click / the end of a titlebar drag) or the browser blocks
 * it — `error` then explains how to allow it. The pop-out closes when the
 * panel closes or unmounts; when the user closes the pop-out (or presses
 * "Return to main window") `host` goes back to null and the panel, which never
 * unmounted, reappears in the main window with all its state.
 */
export function usePopout({ open, storageKey, panelGeometry }: Options) {
  const [host, setHost] = useState<PanelHost | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pendingRef = useRef<{ win: Window; cancel: () => void } | null>(null);
  const popoutKey = popoutStorageKey(storageKey);
  const geometryRef = useRef(panelGeometry);
  useLayoutEffect(() => {
    geometryRef.current = panelGeometry;
  }, [panelGeometry]);

  const cancelPending = useCallback(() => {
    const pending = pendingRef.current;
    pendingRef.current = null;
    if (!pending) return;
    pending.cancel();
    if (!isClosed(pending.win)) pending.win.close();
  }, []);

  const popOut = useCallback(
    (placement?: PopoutGeometry) => {
      if (pendingRef.current) return;
      const saved = loadPopoutGeometry(popoutKey);
      // A drop at the pointer keeps the size the user last gave this pop-out.
      const geometry = placement
        ? { ...placement, width: saved?.width ?? placement.width, height: saved?.height ?? placement.height }
        : saved ?? initialPopoutGeometry(geometryRef.current, window);
      let win: Window | null = null;
      try {
        win = window.open(popoutUrl(), windowName(storageKey), popoutFeatures(geometry));
      } catch {
        win = null;
      }
      if (!win || isClosed(win)) {
        setError(POPOUT_BLOCKED_MESSAGE);
        return;
      }
      setError(null);
      const opened = win;
      const cancel = whenPopoutReady(
        opened,
        () => {
          pendingRef.current = null;
          setHost(panelHostFor(opened.document));
        },
        () => {
          const closedByUser = isClosed(opened);
          pendingRef.current = null;
          if (!closedByUser) {
            opened.close();
            setError(POPOUT_FAILED_MESSAGE);
          }
        },
      );
      pendingRef.current = { win: opened, cancel };
    },
    [popoutKey, storageKey],
  );

  const popIn = useCallback(() => setHost(null), []);
  const clearError = useCallback(() => setError(null), []);

  // A closed panel has no pop-out. Reset during render rather than in an
  // effect, so a reopened panel can never mount into the closed window.
  const [wasOpen, setWasOpen] = useState(open);
  if (wasOpen !== open) {
    setWasOpen(open);
    if (!open) {
      if (host) setHost(null);
      if (error) setError(null);
    }
  }
  useEffect(() => {
    if (!open) cancelPending();
  }, [open, cancelPending]);
  useEffect(() => cancelPending, [cancelPending]);

  // The open pop-out's lifetime: styles mirrored in, registered (so a main
  // window reload closes it), geometry saved, user-close detected.
  useEffect(() => {
    if (!host) return;
    const { win, doc } = host;
    // Moving a window fires no event, and a window the user is closing may
    // already read as closed (screenX 0): sample while it is open, save the
    // last good sample.
    let last: PopoutGeometry | null = null;
    const sample = () => {
      if (!isClosed(win)) last = readPopoutGeometry(win);
    };
    const save = () => {
      sample();
      if (last) savePopoutGeometry(popoutKey, last);
    };
    sample();
    const stopStyles = mirrorDocumentStyles(document, doc);
    const unregister = registerPopout(win, save);
    let resizeTimer: number | null = null;
    const onResize = () => {
      if (resizeTimer !== null) win.clearTimeout(resizeTimer);
      resizeTimer = win.setTimeout(() => {
        resizeTimer = null;
        save();
      }, 250);
    };
    const release = () => setHost((current) => (current?.win === win ? null : current));
    // Closed by the user (or reloaded): the panel returns to the main window.
    const onPageHide = () => {
      save();
      release();
    };
    win.addEventListener('resize', onResize);
    win.addEventListener('pagehide', onPageHide);
    // On the pop-out's own clock: the main window's is throttled while hidden.
    const sampler = win.setInterval(sample, 1000);
    // `pagehide` is skipped for a crashed or force-closed window; poll as well.
    const closedPoll = window.setInterval(() => {
      if (isClosed(win)) release();
    }, 1000);
    return () => {
      window.clearInterval(closedPoll);
      stopStyles();
      unregister();
      try {
        win.clearInterval(sampler);
        win.removeEventListener('resize', onResize);
        win.removeEventListener('pagehide', onPageHide);
        if (resizeTimer !== null) win.clearTimeout(resizeTimer);
      } catch {
        /* the window is gone */
      }
      if (!isClosed(win)) {
        save();
        win.close();
      }
    };
  }, [host, popoutKey]);

  return { host, popOut, popIn, error, clearError };
}
