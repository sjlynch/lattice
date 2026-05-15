import { useState } from 'react';
import { TopAppBar } from './components/TopAppBar';
import { Sidebar } from './components/Sidebar';
import { ForceGraphView } from './components/ForceGraphView';
import { Legend } from './components/Legend';
import { TerminalsProvider } from './TerminalsContext';
import { useActiveFolder } from './hooks/useActiveFolder';
import { useHiddenExtensions } from './hooks/useHiddenExtensions';
import { useMetricsIgnoredExts } from './hooks/useMetricsIgnoredExts';
import { useProjectScan } from './hooks/useProjectScan';
import { useSidebarWidth } from './hooks/useSidebarWidth';
import { useStartupTerminalSync } from './hooks/useStartupTerminalSync';

function App() {
  const [activeFolder, setActiveFolder] = useActiveFolder();
  const { scanResult, loading } = useProjectScan(activeFolder);
  const { hiddenExts, toggleExt } = useHiddenExtensions(activeFolder);
  // Code-health overlay (held `h` key). Lifted here — unlike `z` (LOC)
  // and `Alt` (labels) — so the Legend can swap to a health breakdown
  // panel while it's active. ForceGraphView still owns the keydown
  // listener and pushes changes back up via onHealthModeChange.
  const [healthMode, setHealthMode] = useState(false);
  const { sidebarWidth, onResizerPointerDown, onResizerDoubleClick } =
    useSidebarWidth(activeFolder);
  const [startupTerminals, setStartupTerminals] =
    useStartupTerminalSync(activeFolder);
  const [metricsIgnoredExts, saveMetricsIgnoredExts] =
    useMetricsIgnoredExts(activeFolder);

  return (
    <TerminalsProvider>
      <div className="app-shell">
        <TopAppBar
          activeFolder={activeFolder}
          onSelectFolder={setActiveFolder}
          startupTerminals={startupTerminals}
          onStartupTerminalsChange={setStartupTerminals}
          metricsIgnoredExts={metricsIgnoredExts}
          onMetricsIgnoredExtsChange={saveMetricsIgnoredExts}
          scanResult={scanResult}
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
              metricsIgnoredExts={metricsIgnoredExts}
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
