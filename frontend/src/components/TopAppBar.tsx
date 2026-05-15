import { useState } from 'react';
import { FolderOpen, Settings } from 'lucide-react';
import { FolderPicker } from './FolderPicker';
import { TaskBoardLauncher } from './TaskBoard';
import { WorkflowsLauncher } from './Workflows';
import { SettingsDialog } from './SettingsDialog';
import type { ScanResult, StartupTerminal } from '../api';

type Props = {
  activeFolder: string;
  onSelectFolder: (path: string) => void;
  startupTerminals: StartupTerminal[];
  onStartupTerminalsChange: (next: StartupTerminal[]) => void;
  metricsIgnoredExts: string[];
  onMetricsIgnoredExtsChange: (next: string[]) => void | Promise<void>;
  scanResult: ScanResult | null;
};

export function TopAppBar({
  activeFolder,
  onSelectFolder,
  startupTerminals,
  onStartupTerminalsChange,
  metricsIgnoredExts,
  onMetricsIgnoredExtsChange,
  scanResult,
}: Props) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const folderName = activeFolder
    ? activeFolder.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || activeFolder
    : '(no folder)';

  return (
    <>
      <header className="appbar">
        <div className="appbar-brand">Lattice</div>
        <div className="appbar-folder">
          <span className="appbar-folder-name">{folderName}</span>
          <button
            className="icon-btn sm"
            onClick={() => setPickerOpen(true)}
            title="Select active folder"
            aria-label="Select active folder"
          >
            <FolderOpen size={14} />
          </button>
          <span className="appbar-folder-path" title={activeFolder}>
            {activeFolder}
          </span>
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
        metricsIgnoredExts={metricsIgnoredExts}
        onMetricsIgnoredExtsChange={onMetricsIgnoredExtsChange}
      />
    </>
  );
}
