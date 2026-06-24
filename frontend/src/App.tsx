import { useEffect, useState } from 'react';
import { TopAppBar } from './components/TopAppBar';
import { Sidebar } from './components/Sidebar';
import { ForceGraphView } from './components/ForceGraphView';
import { Legend } from './components/Legend';
import { ErrorBoundary } from './components/ErrorBoundary';
import { ConfirmProvider } from './components/shared/ConfirmDialog';
import { TerminalsProvider } from './TerminalsContext';
import { useActiveFolder } from './hooks/useActiveFolder';
import { useHiddenExtensions } from './hooks/useHiddenExtensions';
import { useMetricsIgnoredExts } from './hooks/useMetricsIgnoredExts';
import { useProjectScan } from './hooks/useProjectScan';
import { useStructuralScan } from './hooks/useStructuralScan';
import { useSidebarWidth } from './hooks/useSidebarWidth';
import { useStartupTerminalSync } from './hooks/useStartupTerminalSync';
import { useUserSettings } from './hooks/useUserSettings';
import {
  ensureProjectInstrumentation,
  normalizeTerminalLaunchSettings,
  type TerminalLaunchSettings,
} from './api';

function App() {
  const [activeFolder, setActiveFolder] = useActiveFolder();
  const { scanResult, loading } = useProjectScan(activeFolder);
  // Structure-stable view of the scan (changes only on add/remove/rename, not
  // on the metric-only HealthUpdates that mint a fresh `scanResult` ref every
  // file save). TopAppBar (→ WorkflowsLauncher) and Legend read only structural
  // fields, so feeding them this ref + memoizing both keeps the app shell off
  // the per-save render path — only ForceGraphView, which needs the metric
  // churn, gets the raw `scanResult`.
  const structuralScan = useStructuralScan(scanResult);
  const { hiddenExts, toggleExt } = useHiddenExtensions(activeFolder);
  // Code-health overlay (held `h` key). Lifted here — unlike `z` (LOC)
  // and `Alt` (labels) — so the Legend can swap to a health breakdown
  // panel while it's active. ForceGraphView still owns the keydown
  // listener and pushes changes back up via onHealthModeChange.
  const [healthMode, setHealthMode] = useState(false);
  // One per-folder fetch of userSettings.json, shared by the hooks below (and
  // the terminal-launch defaults) instead of each fetching it independently.
  const userSettings = useUserSettings(activeFolder);
  const {
    sidebarWidth,
    sidebarSettingsLoaded,
    onResizerPointerDown,
    onResizerDoubleClick,
  } = useSidebarWidth(activeFolder, userSettings);
  const [startupTerminals, setStartupTerminals] =
    useStartupTerminalSync(activeFolder, userSettings);
  const [terminalLaunchSettings, setTerminalLaunchSettings] =
    useState<TerminalLaunchSettings>(normalizeTerminalLaunchSettings(null));
  const [metricsIgnoredExts, saveMetricsIgnoredExts] =
    useMetricsIgnoredExts(activeFolder, userSettings);

  // Terminal-launch defaults read the same shared userSettings; kept as local
  // state so SettingsDialog can update them in place.
  useEffect(() => {
    if (!activeFolder) {
      setTerminalLaunchSettings(normalizeTerminalLaunchSettings(null));
      return;
    }
    if (!userSettings.loaded || !userSettings.settings) return;
    setTerminalLaunchSettings(
      normalizeTerminalLaunchSettings(userSettings.settings),
    );
  }, [activeFolder, userSettings.loaded, userSettings.settings]);

  // Install (or remove, per the saved setting) Lattice's project-level Claude
  // hooks so any session working in this project shows on the graph.
  useEffect(() => {
    if (!activeFolder) return;
    void ensureProjectInstrumentation(activeFolder);
  }, [activeFolder]);

  return (
    <ConfirmProvider>
      <TerminalsProvider>
      <div className="app-shell">
        <TopAppBar
          activeFolder={activeFolder}
          onSelectFolder={setActiveFolder}
          startupTerminals={startupTerminals}
          onStartupTerminalsChange={setStartupTerminals}
          terminalLaunchSettings={terminalLaunchSettings}
          onTerminalLaunchSettingsChange={setTerminalLaunchSettings}
          metricsIgnoredExts={metricsIgnoredExts}
          onMetricsIgnoredExtsChange={saveMetricsIgnoredExts}
          scanResult={structuralScan}
        />
        <div className="app-body">
          {sidebarSettingsLoaded && (
            <>
              <aside className="app-sidebar" style={{ width: sidebarWidth }}>
                <Sidebar
                  activeFolder={activeFolder}
                  startupTerminals={startupTerminals}
                  terminalLaunchSettings={terminalLaunchSettings}
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
            </>
          )}
          <main className="app-graph">
            {/* The force graph (3d-force-graph + WebGL) is the most
                crash-prone subtree; its own boundary keeps a graph fault
                from blanking the sidebar / task board. */}
            <ErrorBoundary compact title="The file graph crashed">
              <ForceGraphView
                data={scanResult}
                loading={loading}
                hiddenExts={hiddenExts}
                metricsIgnoredExts={metricsIgnoredExts}
                activeFolder={activeFolder}
                healthMode={healthMode}
                onHealthModeChange={setHealthMode}
              />
              <Legend
                data={structuralScan}
                hiddenExts={hiddenExts}
                onToggleExt={toggleExt}
                healthMode={healthMode}
              />
            </ErrorBoundary>
          </main>
        </div>
      </div>
      </TerminalsProvider>
    </ConfirmProvider>
  );
}

export default App;
