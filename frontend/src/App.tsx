import { useCallback, useEffect, useMemo, useState } from 'react';
import { TopAppBar } from './components/TopAppBar';
import { Sidebar } from './components/Sidebar';
import { ForceGraphView } from './components/ForceGraphView';
import { Legend } from './components/Legend';
import { TerminalsProvider } from './TerminalsContext';
import {
  fetchDefaultRoot,
  scanFolder,
  subscribeHealth,
  type ScanResult,
} from './api';
import { APP_CONFIG } from './appConfig';
import { useSidebarWidth } from './hooks/useSidebarWidth';
import { useStartupTerminalSync } from './hooks/useStartupTerminalSync';
import { canonicalProjectPath } from './projectPath';

function readStoredActiveFolder(): string {
  try {
    return canonicalProjectPath(
      sessionStorage.getItem(APP_CONFIG.storage.activeFolderSessionKey) ?? '',
    );
  } catch {
    return '';
  }
}

function App() {
  // Seed from sessionStorage synchronously so the persist effect below doesn't
  // wipe the stored value before the loader effect reads it. Effects run in
  // declaration order, and the persist effect fires first — if activeFolder
  // started as '' it would call sessionStorage.removeItem(...) and the per-tab
  // active-folder memory would be lost on every mount.
  const [activeFolder, setActiveFolderRaw] = useState<string>(readStoredActiveFolder);
  // Always canonicalize what we store as activeFolder so per-project keys
  // (terminals filter, settings, hidden-exts) match the canonical form the
  // backend uses for task.projectPath. Keeps a non-canonical path picked
  // via the folder browser from diverging from a task's projectPath.
  const setActiveFolder = useCallback((next: string) => {
    setActiveFolderRaw(canonicalProjectPath(next));
  }, []);
  const [scanResult, setScanResult] = useState<ScanResult | null>(null);
  const [loading, setLoading] = useState(false);
  // Per-extension visibility, persisted per project. Stored as a list of
  // hidden ext keys (e.g., ['.json', '.md']).
  const [hiddenExts, setHiddenExts] = useState<Set<string>>(new Set());
  // Code-health overlay (held `h` key). Lifted here — unlike `z` (LOC)
  // and `Alt` (labels) — so the Legend can swap to a health breakdown
  // panel while it's active. ForceGraphView still owns the keydown
  // listener and pushes changes back up via onHealthModeChange.
  const [healthMode, setHealthMode] = useState(false);
  const { sidebarWidth, onResizerPointerDown, onResizerDoubleClick } =
    useSidebarWidth(activeFolder);
  const [startupTerminals, setStartupTerminals] =
    useStartupTerminalSync(activeFolder);

  const hiddenExtsKey = useMemo(
    () =>
      activeFolder
        ? `${APP_CONFIG.storage.hiddenExtsKeyPrefix}${activeFolder}`
        : null,
    [activeFolder],
  );

  useEffect(() => {
    if (activeFolder) {
      const name = activeFolder.replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? activeFolder;
      document.title = `${name} — Lattice`;
    } else {
      document.title = 'Lattice';
    }
  }, [activeFolder]);

  // Persist the active folder per-tab so refreshing keeps the chosen project,
  // letting multiple Lattice tabs each track their own working directory.
  useEffect(() => {
    try {
      if (activeFolder) {
        sessionStorage.setItem(APP_CONFIG.storage.activeFolderSessionKey, activeFolder);
      } else {
        sessionStorage.removeItem(APP_CONFIG.storage.activeFolderSessionKey);
      }
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
          const delay = Math.min(
            APP_CONFIG.scanRetry.maxDelayMs,
            APP_CONFIG.scanRetry.initialDelayMs
              * APP_CONFIG.scanRetry.backoffFactor ** attempt,
          );
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

  // Live health updates from chokidar on the backend. Each event
  // either patches a single file's metrics in place (on save) or
  // removes its node entirely (on delete). We patch the existing
  // scan result rather than re-scanning to keep simulation positions
  // stable.
  useEffect(() => {
    if (!activeFolder) return;
    return subscribeHealth(activeFolder, (event) => {
      setScanResult((prev) => {
        if (!prev) return prev;
        if (event.type === 'updated') {
          const idx = prev.nodes.findIndex(
            (n) => n.kind === 'file' && n.path === event.filePath,
          );
          if (idx === -1) return prev;
          const nextNodes = prev.nodes.slice();
          nextNodes[idx] = {
            ...nextNodes[idx],
            health: event.metrics.score,
            healthDetails: event.metrics,
            loc: event.metrics.loc,
          };
          return { ...prev, nodes: nextNodes };
        }
        // event.type === 'removed' — drop the node + any links to it.
        const filtered = prev.nodes.filter((n) => n.path !== event.filePath);
        if (filtered.length === prev.nodes.length) return prev;
        const nextLinks = prev.links.filter(
          (l) => l.source !== event.filePath && l.target !== event.filePath,
        );
        return { ...prev, nodes: filtered, links: nextLinks };
      });
    });
  }, [activeFolder]);

  const toggleExt = useCallback((key: string) => {
    setHiddenExts((cur) => {
      const next = new Set(cur);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);


  return (
    <TerminalsProvider>
      <div className="app-shell">
        <TopAppBar
          activeFolder={activeFolder}
          onSelectFolder={setActiveFolder}
          startupTerminals={startupTerminals}
          onStartupTerminalsChange={setStartupTerminals}
        />
        <div className="app-body">
          <aside className="app-sidebar" style={{ width: sidebarWidth }}>
            <Sidebar
              activeFolder={activeFolder}
              startupTerminals={startupTerminals}
            />
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
              healthMode={healthMode}
              onHealthModeChange={setHealthMode}
            />
            <Legend
              data={scanResult}
              hiddenExts={hiddenExts}
              onToggleExt={toggleExt}
              healthMode={healthMode}
            />
          </main>
        </div>
      </div>
    </TerminalsProvider>
  );
}

export default App;
