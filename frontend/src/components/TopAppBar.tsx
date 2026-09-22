import { memo, useEffect, useState } from 'react';
import { FolderOpen, GitBranch, Settings } from 'lucide-react';
import { FolderPicker } from './FolderPicker';
import { TaskBoardLauncher } from './TaskBoard';
import { WorkflowsLauncher } from './Workflows';
import { SettingsDialog } from './SettingsDialog';
import { checkGit, subscribeGitBranch } from '../api';
import type {
  ProjectGitProbe,
  ScanResult,
  StartupTerminal,
  TerminalLaunchSettings,
} from '../api';
import { deriveGitChipState } from './gitSetup/gitSetupDerive';
import { useGitSetup, useGitSetupNonce } from './gitSetup/GitSetupProvider';

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
  const [gitProbe, setGitProbe] = useState<ProjectGitProbe | null>(null);
  const { ensureGitRepo } = useGitSetup();
  // Bumped by the provider after a repo is created — from here or from any
  // other entry point — so both effects below re-run and the chip flips.
  const gitSetupNonce = useGitSetupNonce();

  const folderName = activeFolder
    ? activeFolder.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || activeFolder
    : '(no folder)';

  // Live-track the active folder's current git branch for the navbar indicator.
  // A WS subscription pushes the branch on connect and again whenever a terminal
  // (a Claude console) or the user switches branches, so the chip updates without
  // a page refresh. Cleared immediately on folder change so a stale branch from
  // the previous project never lingers; tearing down the subscription drops any
  // late message from the old folder, so no extra guard is needed.
  //
  // Re-subscribing on `gitSetupNonce` is the cheap guarantee that a just-created
  // repo shows its branch: the backend's `.git/HEAD` watcher may have been armed
  // while there was no `.git` to watch, and a fresh connect always pushes the
  // current branch.
  useEffect(() => {
    if (!activeFolder) {
      setBranch(null);
      return;
    }
    setBranch(null);
    return subscribeGitBranch(activeFolder, setBranch);
  }, [activeFolder, gitSetupNonce]);

  // The git *state* of the folder, which the branch stream can't report: it has
  // nothing to say about a folder that isn't a repo, which is exactly the case
  // this chip exists for.
  useEffect(() => {
    if (!activeFolder) {
      setGitProbe(null);
      return;
    }
    let cancelled = false;
    setGitProbe(null);
    checkGit(activeFolder)
      .then((r) => {
        // `git` is absent on a backend that predates the Git-setup contract;
        // deriveGitChipState treats null as "unknown" and falls back to the
        // plain branch chip.
        if (!cancelled) setGitProbe(r.git ?? null);
      })
      .catch(() => {
        if (!cancelled) setGitProbe(null);
      });
    return () => {
      cancelled = true;
    };
  }, [activeFolder, gitSetupNonce]);

  const gitChip = deriveGitChipState(gitProbe, branch);

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
          {gitChip?.kind === 'action' ? (
            <button
              className="appbar-branch appbar-branch-action"
              title={gitChip.title}
              onClick={() => void ensureGitRepo(activeFolder)}
            >
              <GitBranch size={13} className="appbar-branch-icon" />
              <span className="appbar-branch-name">{gitChip.label}</span>
            </button>
          ) : gitChip ? (
            <span
              className={
                gitChip.kind === 'info' && gitChip.tone === 'warning'
                  ? 'appbar-branch appbar-branch-warning'
                  : 'appbar-branch'
              }
              title={gitChip.title}
            >
              <GitBranch size={13} className="appbar-branch-icon" />
              <span className="appbar-branch-name">{gitChip.label}</span>
            </span>
          ) : null}
        </div>
        <WorkflowsLauncher activeFolder={activeFolder} scanResult={scanResult} />
        <TaskBoardLauncher activeFolder={activeFolder} />
        <button
          className="icon-btn sm"
          onClick={() => setSettingsOpen(true)}
          title="Settings"
          aria-label="Settings"
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
