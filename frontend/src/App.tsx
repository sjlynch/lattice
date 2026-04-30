import { useCallback, useEffect, useMemo, useState } from 'react';
import { TopAppBar } from './components/TopAppBar';
import { Sidebar } from './components/Sidebar';
import { ForceGraphView } from './components/ForceGraphView';
import { TaskBoardLauncher } from './components/TaskBoard';
import { Legend } from './components/Legend';
import { TerminalsProvider } from './TerminalsContext';
import { fetchDefaultRoot, scanFolder, type ScanResult } from './api';

function App() {
  const [activeFolder, setActiveFolder] = useState<string>('');
  const [scanResult, setScanResult] = useState<ScanResult | null>(null);
  const [loading, setLoading] = useState(false);
  // Per-extension visibility, persisted per project. Stored as a list of
  // hidden ext keys (e.g., ['.json', '.md']).
  const [hiddenExts, setHiddenExts] = useState<Set<string>>(new Set());

  const hiddenExtsKey = useMemo(
    () =>
      activeFolder ? `lattice.hiddenExts.${activeFolder}` : null,
    [activeFolder],
  );

  useEffect(() => {
    fetchDefaultRoot()
      .then(setActiveFolder)
      .catch(() => setActiveFolder(''));
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
    setLoading(true);
    scanFolder(activeFolder)
      .then((r) => {
        if (!cancelled) setScanResult(r);
      })
      .catch((err) => {
        console.error('scan failed', err);
        if (!cancelled) setScanResult(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
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

  return (
    <TerminalsProvider>
      <div className="app-shell">
        <TopAppBar activeFolder={activeFolder} onSelectFolder={setActiveFolder} />
        <div className="app-body">
          <aside className="app-sidebar">
            <Sidebar activeFolder={activeFolder} />
          </aside>
          <main className="app-graph">
            <ForceGraphView
              data={scanResult}
              loading={loading}
              hiddenExts={hiddenExts}
            />
            <Legend
              data={scanResult}
              hiddenExts={hiddenExts}
              onToggleExt={toggleExt}
            />
            <TaskBoardLauncher activeFolder={activeFolder} />
          </main>
        </div>
      </div>
    </TerminalsProvider>
  );
}

export default App;
