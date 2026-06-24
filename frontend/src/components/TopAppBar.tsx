import { memo, useEffect, useState } from 'react';
import { FolderOpen, GitBranch, Settings } from 'lucide-react';
import { FolderPicker } from './FolderPicker';
import { TaskBoardLauncher } from './TaskBoard';
import { WorkflowsLauncher } from './Workflows';
import { SettingsDialog } from './SettingsDialog';
import { fetchGitBranch } from '../api';
import type { ScanResult, StartupTerminal, TerminalLaunchSettings } from '../api';

type Props = {
  activeFolder: string;
  onSelectFolder: (path: string) => void;
  startupTerminals: StartupTerminal[];
  onStartupTerminalsChange: (next: StartupTerminal[]) => void;
  terminalLaunchSettings: TerminalLaunchSettings;
  onTerminalLaunchSettingsChange: (next: TerminalLaunchSettings) => void;
  metricsIgnoredExts: string[];
  onMetricsIgnoredExtsChange: (next: string[]) => void | Promise<void>;
  scanResult: ScanResult | null;
};

// Memoized: App now feeds TopAppBar the structure-stable scan ref (→
// WorkflowsLauncher → useWorkflowManager, which reads only structural fields)
// and its other props are reference-stable across health updates, so the memo
// bails on a metric-only file save instead of re-rendering the whole app bar.
export const TopAppBar = memo(function TopAppBar({
  activeFolder,
  onSelectFolder,
  startupTerminals,
  onStartupTerminalsChange,
  terminalLaunchSettings,
  onTerminalLaunchSettingsChange,
  metricsIgnoredExts,
  onMetricsIgnoredExtsChange,
  scanResult,
}: Props) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [branch, setBranch] = useState<string | null>(null);

  const folderName = activeFolder
    ? activeFolder.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || activeFolder
    : '(no folder)';

  // Resolve the active folder's current git branch for the navbar indicator.
  // Cleared immediately on folder change so a stale branch from the previous
  // project never lingers, and guarded so a slow lookup that resolves after
  // another switch doesn't overwrite the newer folder's branch.
  useEffect(() => {
    if (!activeFolder) {
      setBranch(null);
      return;
    }
    let cancelled = false;
    setBranch(null);
    fetchGitBranch(activeFolder).then((b) => {
      if (!cancelled) setBranch(b);
    });
    return () => {
      cancelled = true;
    };
  }, [activeFolder]);

  return (
    <>
      <header className="appbar">
        <div className="appbar-folder">
          <button
            className="icon-btn sm"
            onClick={() => setPickerOpen(true)}
            title="Select active folder"
            aria-label="Select active folder"
          >
            <FolderOpen size={14} />
          </button>
          <span className="appbar-folder-name">{folderName}</span>
          <span className="appbar-folder-path" title={activeFolder}>
            {activeFolder}
          </span>
          {branch && (
            <span className="appbar-branch" title={`Current git branch: ${branch}`}>
              <GitBranch size={13} className="appbar-branch-icon" />
              <span className="appbar-branch-name">{branch}</span>
            </span>
          )}
        </div>
        <WorkflowsLauncher activeFolder={activeFolder} scanResult={scanResult} />
        <TaskBoardLauncher activeFolder={activeFolder} />
        <button
          className="icon-btn sm"
          onClick={() => setSettingsOpen(true)}
          title="Settings"
          aria-label="Settings"
          disabled={!activeFolder}
          style={{ marginLeft: 4 }}
        >
          <Settings size={14} />
        </button>
      </header>
      <FolderPicker
        open={pickerOpen}
        initialPath={activeFolder}
        onClose={() => setPickerOpen(false)}
        onSelect={(p) => {
          setPickerOpen(false);
          onSelectFolder(p);
        }}
      />
      <SettingsDialog
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        activeFolder={activeFolder}
        startupTerminals={startupTerminals}
        onStartupTerminalsChange={onStartupTerminalsChange}
        terminalLaunchSettings={terminalLaunchSettings}
        onTerminalLaunchSettingsChange={onTerminalLaunchSettingsChange}
        metricsIgnoredExts={metricsIgnoredExts}
        onMetricsIgnoredExtsChange={onMetricsIgnoredExtsChange}
      />
    </>
  );
});
