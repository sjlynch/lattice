import { useCallback, useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { APP_CONFIG } from '../appConfig';
import { patchUserSettings } from '../api';
import { useSyncedRef } from './useSyncedRef';
import type { UserSettingsResult } from './useUserSettings';

function clampSidebarWidth(width: number) {
  const viewportCap = window.innerWidth - APP_CONFIG.sidebar.minGraphWidth;
  return Math.max(
    APP_CONFIG.sidebar.minWidth,
    Math.min(viewportCap, Math.round(width)),
  );
}

// A drag released inside the graph's last `minGraphWidth` strip means "give the
// terminals the whole page": the sidebar goes full width and the graph hides.
function isFullWidthDrag(x: number) {
  return x > window.innerWidth - APP_CONFIG.sidebar.minGraphWidth;
}

export function useSidebarWidth(
  activeFolder: string,
  userSettings: UserSettingsResult,
) {
  const [sidebarWidth, setSidebarWidth] = useState<number>(
    APP_CONFIG.sidebar.defaultWidth,
  );
  const [sidebarMaximized, setSidebarMaximized] = useState(false);
  const [sidebarSettingsLoaded, setSidebarSettingsLoaded] = useState(
    () => !activeFolder,
  );
  const resizingRef = useRef(false);
  const resizeCleanupRef = useRef<(() => void) | null>(null);
  const activeFolderRef = useSyncedRef(activeFolder);
  const { settings, loaded } = userSettings;

  // Apply the per-project sidebar width from the shared userSettings fetch
  // (useUserSettings) when the active folder changes.
  // Only gates the FIRST mount: once the sidebar has shown for any project,
  // subsequent project switches keep it mounted and just update the width
  // in place. Flipping `sidebarSettingsLoaded` back to false on every
  // activeFolder change tore down the whole sidebar (and every TerminalPane
  // inside it) mid-session, which on Windows abandoned the in-flight WS
  // attach for any just-created terminal — the user saw a tab but never
  // got a shell. Keeping it mounted means the previous width stays put for
  // a moment until the new project's value arrives; a brief width hold is
  // strictly less disruptive than a full sidebar remount. While the shared
  // fetch is in flight (`!loaded`) we do nothing — `sidebarSettingsLoaded`
  // is never reset to false on a folder switch — so the sidebar stays put.
  useEffect(() => {
    if (!activeFolder) {
      setSidebarSettingsLoaded(true);
      return;
    }

    if (!loaded || !settings) return; // hold previous width until settings arrive

    // A project with no saved width gets the default, not whatever width the
    // previous project was dragged to.
    setSidebarWidth(
      clampSidebarWidth(
        typeof settings.sidebarWidth === 'number'
          ? settings.sidebarWidth
          : APP_CONFIG.sidebar.defaultWidth,
      ),
    );
    setSidebarMaximized(settings.sidebarMaximized === true);
    setSidebarSettingsLoaded(true);
  }, [activeFolder, loaded, settings]);

  // Re-clamp on window resize so the sidebar can't exceed its viewport cap
  // (a full-width sidebar just follows the window).
  useEffect(() => {
    function onResize() {
      setSidebarWidth((width) => clampSidebarWidth(width));
    }
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // An interrupted drag must release its resources without committing settings.
  useEffect(() => () => resizeCleanupRef.current?.(), []);

  const onResizerPointerDown = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    resizeCleanupRef.current?.();
    resizingRef.current = true;
    const target = e.currentTarget;
    const pointerId = e.pointerId;
    try {
      target.setPointerCapture(pointerId);
    } catch {
      /* ignore */
    }
    const prevUserSelect = document.body.style.userSelect;
    const prevCursor = document.body.style.cursor;
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'ew-resize';

    // Coalesce pointer moves to one width commit per animation frame: each
    // commit re-renders App (and lays the graph + sidebar out again), and a
    // pointer delivers several moves per frame.
    let active = true;
    let frame: number | null = null;
    let latestX: number | null = null;
    const apply = (x: number) => {
      const full = isFullWidthDrag(x);
      setSidebarMaximized(full);
      if (!full) setSidebarWidth(clampSidebarWidth(x));
      return full;
    };
    const handleMove = (ev: PointerEvent) => {
      if (!active || !resizingRef.current) return;
      latestX = ev.clientX;
      if (frame !== null) return;
      frame = requestAnimationFrame(() => {
        frame = null;
        if (active && resizingRef.current && latestX !== null) apply(latestX);
      });
    };
    const cleanup = () => {
      if (!active) return;
      active = false;
      resizingRef.current = false;
      if (frame !== null) {
        cancelAnimationFrame(frame);
        frame = null;
      }
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleUp);
      window.removeEventListener('pointercancel', handleUp);
      try {
        target.releasePointerCapture(pointerId);
      } catch {
        /* ignore */
      }
      document.body.style.userSelect = prevUserSelect;
      document.body.style.cursor = prevCursor;
      if (resizeCleanupRef.current === cleanup) resizeCleanupRef.current = null;
    };
    const handleUp = (ev: PointerEvent) => {
      if (!active) return;
      // The final width comes from the release point, not the state ref: the
      // last coalesced frame may not have committed yet. A `pointercancel`
      // (touch cancelled, window lost the pointer) carries no useful
      // coordinates — often clientX 0, which would slam the sidebar to its
      // minimum — so it settles on the last move instead; with no move at all
      // there is nothing to commit.
      const releaseX = ev.type === 'pointercancel' ? latestX : ev.clientX;
      cleanup();
      const finalFull = releaseX === null ? null : apply(releaseX);
      if (activeFolderRef.current && releaseX !== null) {
        // A full-width release keeps the stored width as the last non-full one.
        patchUserSettings(
          activeFolderRef.current,
          finalFull
            ? { sidebarMaximized: true }
            : { sidebarWidth: clampSidebarWidth(releaseX), sidebarMaximized: false },
        ).catch(() => {});
      }
    };
    resizeCleanupRef.current = cleanup;
    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleUp);
    window.addEventListener('pointercancel', handleUp);
  }, [activeFolderRef]);

  const onResizerDoubleClick = useCallback(() => {
    const width = clampSidebarWidth(APP_CONFIG.sidebar.defaultWidth);
    setSidebarWidth(width);
    setSidebarMaximized(false);
    if (activeFolderRef.current) {
      patchUserSettings(activeFolderRef.current, {
        sidebarWidth: width,
        sidebarMaximized: false,
      }).catch(() => {});
    }
  }, [activeFolderRef]);

  return {
    sidebarWidth,
    sidebarMaximized,
    sidebarSettingsLoaded,
    onResizerPointerDown,
    onResizerDoubleClick,
  };
}
