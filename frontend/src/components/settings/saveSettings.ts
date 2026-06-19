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
import { type InstructionTemplatesTabHandle } from './InstructionTemplatesTab';
import { type MetricsIgnoredExtsTabHandle } from './MetricsIgnoredExtsTab';
import { type AgentsTabHandle } from './AgentsTab';
import { type McpTabHandle } from './McpTab';

// The parent-owned draft values that participate in a save.
type SaveDrafts = {
  terminalDefaultHarness: TerminalDefaultHarness;
  terminalClaudeSkipPermissions: boolean;
  instrumentClaude: boolean;
  disableMemory: boolean;
};

// Imperative handles for each tab. Each may be null if its tab hasn't
// mounted yet; the save reads patches defensively.
type SaveHandles = {
  startupTerminals: StartupTerminalsTabHandle | null;
  envNotes: EnvNotesTabHandle | null;
  instructionTemplates: InstructionTemplatesTabHandle | null;
  metricsIgnoredExts: MetricsIgnoredExtsTabHandle | null;
  agents: AgentsTabHandle | null;
  mcp: McpTabHandle | null;
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
    disableClaudeMemory: drafts.disableMemory,
  };
  // Only touch worktreeEnvNotes if the env fetch finished — otherwise we'd
  // overwrite the saved overrides with an empty map.
  const envNotesPatch = handles.envNotes?.getWorktreeEnvNotesPatch();
  if (envNotesPatch !== undefined) patch.worktreeEnvNotes = envNotesPatch;
  // Only touch instructionTemplateOverrides once the editor has loaded — same
  // clobber-guard as env notes (the patch is the full desired override map).
  const templatesPatch =
    handles.instructionTemplates?.getInstructionTemplateOverridesPatch();
  if (templatesPatch !== undefined) {
    patch.instructionTemplateOverrides = templatesPatch;
  }
  const metricsExtsPatch = handles.metricsIgnoredExts?.getMetricsIgnoredExtsPatch();
  if (metricsExtsPatch !== undefined) {
    patch.metricsIgnoredExts = metricsExtsPatch;
  }
  // MCP per-project enables (mcpOverrides + qaPlaywright). Secrets / imports /
  // custom-server defs persist on their own immediately, so they're not here.
  const mcpPatch = handles.mcp?.getMcpUserPatch();
  if (mcpPatch !== undefined) Object.assign(patch, mcpPatch);

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
