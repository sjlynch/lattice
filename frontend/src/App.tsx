import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { TopAppBar } from './components/TopAppBar';
import { Sidebar } from './components/Sidebar';
import { ForceGraphView } from './components/ForceGraphView';
import { Legend } from './components/Legend';
import { TerminalsProvider } from './TerminalsContext';
import { fetchDefaultRoot, scanFolder, fetchUserSettings, patchUserSettings, type ScanResult } from './api';

const SIDEBAR_MIN_WIDTH = 240;
const SIDEBAR_MAX_WIDTH = 1200;
const SIDEBAR_DEFAULT_WIDTH = 380;
const ACTIVE_FOLDER_SESSION_KEY = 'lattice.activeFolder';

function readStoredActiveFolder(): string {
  try {
    return sessionStorage.getItem(ACTIVE_FOLDER_SESSION_KEY) ?? '';
  } catch {
    return '';
  }
}

function clampSidebarWidth(w: number) {
  const cap = Math.min(SIDEBAR_MAX_WIDTH, Math.floor(window.innerWidth * 0.8));
  return Math.max(SIDEBAR_MIN_WIDTH, Math.min(cap, Math.round(w)));
}

function App() {
  // Seed from sessionStorage synchronously so the persist effect below doesn't
  // wipe the stored value before the loader effect reads it. Effects run in
  // declaration order, and the persist effect fires first — if activeFolder
  // started as '' it would call sessionStorage.removeItem(...) and the per-tab
  // active-folder memory would be lost on every mount.
  const [activeFolder, setActiveFolder] = useState<string>(readStoredActiveFolder);
  const [scanResult, setScanResult] = useState<ScanResult | null>(null);
  const [loading, setLoading] = useState(false);
  // Per-extension visibility, persisted per project. Stored as a list of
  // hidden ext keys (e.g., ['.json', '.md']).
  const [hiddenExts, setHiddenExts] = useState<Set<string>>(new Set());
  const [sidebarWidth, setSidebarWidth] = useState<number>(SIDEBAR_DEFAULT_WIDTH);
  const resizingRef = useRef(false);
  // Kept in sync via effect so event-handler closures always read the latest value
  const activeFolderRef = useRef('');
  const sidebarWidthRef = useRef(SIDEBAR_DEFAULT_WIDTH);

  const hiddenExtsKey = useMemo(
    () =>
      activeFolder ? `lattice.hiddenExts.${activeFolder}` : null,
    [activeFolder],
  );

  useEffect(() => { activeFolderRef.current = activeFolder; }, [activeFolder]);
  useEffect(() => { sidebarWidthRef.current = sidebarWidth; }, [sidebarWidth]);

  // Persist the active folder per-tab so refreshing keeps the chosen project,
  // letting multiple Lattice tabs each track their own working directory.
  useEffect(() => {
    try {
      if (activeFolder) sessionStorage.setItem(ACTIVE_FOLDER_SESSION_KEY, activeFolder);
      else sessionStorage.removeItem(ACTIVE_FOLDER_SESSION_KEY);
    } catch {
      /* ignore */
    }
  }, [activeFolder]);

  // If the tab had no stored folder (fresh tab), fall back to the backend's
  // default project. The stored case is already handled by the useState seed
  // above, so we only call fetchDefaultRoot when activeFolder is still empty.
  useEffect(() => {
    if (activeFolder) return;
    fetchDefaultRoot()
      .then(setActiveFolder)
      .catch(() => setActiveFolder(''));
    // Only run on mount — once the user picks a folder we don't want to keep
    // refetching the default if they later clear it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Load per-project sidebar width from backend when the active folder changes
  useEffect(() => {
    if (!activeFolder) return;
    fetchUserSettings(activeFolder)
      .then((s) => {
        if (typeof s.sidebarWidth === 'number') {
          setSidebarWidth(clampSidebarWidth(s.sidebarWidth));
        }
      })
      .catch(() => { /* ignore — keep default */ });
  }, [activeFolder]);

  // Load hidden-exts for the active folder
  useEffect(() => {
    if (!hiddenExtsKey) {
      setHiddenExts(new Set());
      return;
    }
    try {
      const raw = localStorage.getItem(hiddenExtsKey);
      if (raw) {
        const arr = JSON.parse(raw);
        if (Array.isArray(arr)) {
          setHiddenExts(new Set(arr.map(String)));
          return;
        }
      }
    } catch {
      /* ignore */
    }
    setHiddenExts(new Set());
  }, [hiddenExtsKey]);

  // Persist when it changes
  useEffect(() => {
    if (!hiddenExtsKey) return;
    try {
      localStorage.setItem(hiddenExtsKey, JSON.stringify(Array.from(hiddenExts)));
    } catch {
      /* ignore */
    }
  }, [hiddenExts, hiddenExtsKey]);

  useEffect(() => {
    if (!activeFolder) return;
    let cancelled = false;
    let attempt = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    setLoading(true);

    function tryScan() {
      if (cancelled) return;
      scanFolder(activeFolder)
        .then((r) => {
          if (cancelled) return;
          setScanResult(r);
          setLoading(false);
        })
        .catch((err) => {
          if (cancelled) return;
          // Backend is probably still starting (boot race) or briefly
          // restarted. Retry with exponential backoff capped at 5s.
          // Loading stays true so the user keeps seeing the indicator
          // until we actually succeed.
          console.warn('scan failed (retrying)', err);
          const delay = Math.min(5000, 300 * 2 ** attempt);
          attempt += 1;
          timer = setTimeout(tryScan, delay);
        });
    }

    tryScan();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [activeFolder]);

  const toggleExt = useCallback((key: string) => {
    setHiddenExts((cur) => {
      const next = new Set(cur);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  // Re-clamp on window resize so the sidebar can't exceed 80% of viewport
  useEffect(() => {
    function onResize() {
      setSidebarWidth((w) => clampSidebarWidth(w));
    }
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const onResizerPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
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
        patchUserSettings(activeFolderRef.current, { sidebarWidth: sidebarWidthRef.current }).catch(() => {});
      }
    };
    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleUp);
    window.addEventListener('pointercancel', handleUp);
  }, []);

  const onResizerDoubleClick = useCallback(() => {
    const w = clampSidebarWidth(SIDEBAR_DEFAULT_WIDTH);
    setSidebarWidth(w);
    if (activeFolderRef.current) {
      patchUserSettings(activeFolderRef.current, { sidebarWidth: w }).catch(() => {});
    }
  }, []);

  return (
    <TerminalsProvider>
      <div className="app-shell">
        <TopAppBar activeFolder={activeFolder} onSelectFolder={setActiveFolder} />
        <div className="app-body">
          <aside className="app-sidebar" style={{ width: sidebarWidth }}>
            <Sidebar activeFolder={activeFolder} />
          </aside>
          <div
            className="app-resizer"
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize sidebar"
            onPointerDown={onResizerPointerDown}
            onDoubleClick={onResizerDoubleClick}
            title="Drag to resize · double-click to reset"
          />
          <main className="app-graph">
            <ForceGraphView
              data={scanResult}
              loading={loading}
              hiddenExts={hiddenExts}
              activeFolder={activeFolder}
            />
            <Legend
              data={scanResult}
              hiddenExts={hiddenExts}
              onToggleExt={toggleExt}
            />
          </main>
        </div>
      </div>
    </TerminalsProvider>
  );
}

export default App;
