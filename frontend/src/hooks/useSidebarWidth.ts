import { useCallback, useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { APP_CONFIG } from '../appConfig';
import { fetchUserSettings, patchUserSettings } from '../api';
import { useSyncedRef } from './useSyncedRef';

function clampSidebarWidth(width: number) {
  const viewportCap = Math.min(
    APP_CONFIG.sidebar.maxWidth,
    Math.floor(window.innerWidth * APP_CONFIG.sidebar.maxViewportRatio),
  );
  return Math.max(
    APP_CONFIG.sidebar.minWidth,
    Math.min(viewportCap, Math.round(width)),
  );
}

export function useSidebarWidth(activeFolder: string) {
  const [sidebarWidth, setSidebarWidth] = useState<number>(
    APP_CONFIG.sidebar.defaultWidth,
  );
  const [sidebarSettingsLoaded, setSidebarSettingsLoaded] = useState(
    () => !activeFolder,
  );
  const resizingRef = useRef(false);
  const activeFolderRef = useSyncedRef(activeFolder);
  const sidebarWidthRef = useSyncedRef(sidebarWidth);

  // Load per-project sidebar width from backend when the active folder changes.
  // While this is pending, callers can avoid mounting width-sensitive terminal
  // panes so xterm opens only after the saved preference has been applied.
  useEffect(() => {
    let cancelled = false;

    if (!activeFolder) {
      setSidebarSettingsLoaded(true);
      return () => {
        cancelled = true;
      };
    }

    setSidebarSettingsLoaded(false);
    fetchUserSettings(activeFolder)
      .then((settings) => {
        if (cancelled) return;
        if (typeof settings.sidebarWidth === 'number') {
          setSidebarWidth(clampSidebarWidth(settings.sidebarWidth));
        }
      })
      .catch(() => { /* ignore — keep current width */ })
      .finally(() => {
        if (!cancelled) setSidebarSettingsLoaded(true);
      });

    return () => {
      cancelled = true;
    };
  }, [activeFolder]);

  // Re-clamp on window resize so the sidebar can't exceed its viewport cap.
  useEffect(() => {
    function onResize() {
      setSidebarWidth((width) => clampSidebarWidth(width));
    }
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const onResizerPointerDown = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    resizingRef.current = true;
    const target = e.currentTarget;
    try {
      target.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    const prevUserSelect = document.body.style.userSelect;
    const prevCursor = document.body.style.cursor;
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'ew-resize';

    const handleMove = (ev: PointerEvent) => {
      if (!resizingRef.current) return;
      setSidebarWidth(clampSidebarWidth(ev.clientX));
    };
    const handleUp = (ev: PointerEvent) => {
      resizingRef.current = false;
      document.body.style.userSelect = prevUserSelect;
      document.body.style.cursor = prevCursor;
      try {
        target.releasePointerCapture(ev.pointerId);
      } catch {
        /* ignore */
      }
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleUp);
      window.removeEventListener('pointercancel', handleUp);
      if (activeFolderRef.current) {
        patchUserSettings(activeFolderRef.current, {
          sidebarWidth: sidebarWidthRef.current,
        }).catch(() => {});
      }
    };
    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleUp);
    window.addEventListener('pointercancel', handleUp);
  }, [activeFolderRef, sidebarWidthRef]);

  const onResizerDoubleClick = useCallback(() => {
    const width = clampSidebarWidth(APP_CONFIG.sidebar.defaultWidth);
    setSidebarWidth(width);
    if (activeFolderRef.current) {
      patchUserSettings(activeFolderRef.current, { sidebarWidth: width }).catch(() => {});
    }
  }, [activeFolderRef]);

  return {
    sidebarWidth,
    sidebarSettingsLoaded,
    onResizerPointerDown,
    onResizerDoubleClick,
  };
}
