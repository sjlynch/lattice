import {
  ensureProjectInstrumentation,
  patchGlobalSettings,
  patchUserSettings,
  type StartupTerminal,
  type TerminalDefaultHarness,
  type TerminalLaunchSettings,
  type UserSettings,
} from '../../api';
import {
  cleanStartupTerminals,
  type StartupTerminalsTabHandle,
} from './StartupTerminalsTab';
import { type EnvNotesTabHandle } from './EnvNotesTab';
import { type MetricsIgnoredExtsTabHandle } from './MetricsIgnoredExtsTab';
import { type AgentsTabHandle } from './AgentsTab';

// The parent-owned draft values that participate in a save.
type SaveDrafts = {
  terminalDefaultHarness: TerminalDefaultHarness;
  terminalClaudeSkipPermissions: boolean;
  instrumentClaude: boolean;
};

// Imperative handles for each tab. Each may be null if its tab hasn't
// mounted yet; the save reads patches defensively.
type SaveHandles = {
  startupTerminals: StartupTerminalsTabHandle | null;
  envNotes: EnvNotesTabHandle | null;
  metricsIgnoredExts: MetricsIgnoredExtsTabHandle | null;
  agents: AgentsTabHandle | null;
};

export type SaveSettingsParams = {
  activeFolder: string;
  startupTerminals: StartupTerminal[];
  drafts: SaveDrafts;
  handles: SaveHandles;
  onStartupTerminalsChange: (next: StartupTerminal[]) => void;
  onTerminalLaunchSettingsChange: (next: TerminalLaunchSettings) => void;
  onMetricsIgnoredExtsChange: (next: string[]) => void | Promise<void>;
};

// Save orchestration for SettingsDialog, with the ordering made explicit:
//  1. collect cleaned startup terminals (+ the other per-tab patches),
//  2. patch project user settings,
//  3. install/remove project Claude instrumentation per the just-saved toggle,
//  4. patch global max-concurrent-agents if it changed,
//  5. notify the parent callbacks.
// Closing the dialog and the saving/error UI state stay with the dialog.
// Throws on failure so the caller can surface the error.
export async function saveSettings({
  activeFolder,
  startupTerminals,
  drafts,
  handles,
  onStartupTerminalsChange,
  onTerminalLaunchSettingsChange,
  onMetricsIgnoredExtsChange,
}: SaveSettingsParams): Promise<void> {
  // 1. Collect the cleaned startup terminals and the optional per-tab patches.
  const cleaned =
    handles.startupTerminals?.getCleanedTerminals() ??
    cleanStartupTerminals(startupTerminals);
  const terminalLaunchPatch: TerminalLaunchSettings = {
    terminalDefaultHarness: drafts.terminalDefaultHarness,
    terminalClaudeSkipPermissions: drafts.terminalClaudeSkipPermissions,
  };
  const patch: Partial<UserSettings> = {
    startupTerminals: cleaned,
    ...terminalLaunchPatch,
    instrumentProjectClaudeSessions: drafts.instrumentClaude,
  };
  // Only touch worktreeEnvNotes if the env fetch finished — otherwise we'd
  // overwrite the saved overrides with an empty map.
  const envNotesPatch = handles.envNotes?.getWorktreeEnvNotesPatch();
  if (envNotesPatch !== undefined) patch.worktreeEnvNotes = envNotesPatch;
  const metricsExtsPatch = handles.metricsIgnoredExts?.getMetricsIgnoredExtsPatch();
  if (metricsExtsPatch !== undefined) {
    patch.metricsIgnoredExts = metricsExtsPatch;
  }

  // 2. Persist the project user settings.
  await patchUserSettings(activeFolder, patch);

  // 3. Apply the install/remove of project hooks per the just-saved toggle.
  void ensureProjectInstrumentation(activeFolder);

  // 4. Machine-global settings go to a separate endpoint, not userSettings.
  const maxAgentsPatch = handles.agents?.getMaxConcurrentAgentsPatch();
  if (maxAgentsPatch !== undefined) {
    await patchGlobalSettings({ maxConcurrentAgents: maxAgentsPatch });
  }

  // 5. Notify the parent callbacks.
  onStartupTerminalsChange(cleaned);
  onTerminalLaunchSettingsChange(terminalLaunchPatch);
  if (metricsExtsPatch !== undefined) {
    await onMetricsIgnoredExtsChange(metricsExtsPatch);
  }
}
