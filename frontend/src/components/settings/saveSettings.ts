import {
  ensureProjectInstrumentation,
  patchGlobalSettings,
  patchUserSettings,
  type RestoreTerminalsMode,
  type StartupTerminal,
  type TerminalDefaultHarness,
  type TerminalLaunchSettings,
  type UserSettings,
} from '../../api';
import { notifyPiModelsChanged } from '../../piModelMenuStore';
import {
  cleanStartupTerminals,
  type StartupTerminalsTabHandle,
} from './StartupTerminalsTab';
import { type EnvNotesTabHandle } from './EnvNotesTab';
import { type InstructionTemplatesTabHandle } from './InstructionTemplatesTab';
import { type HarnessSystemPromptsTabHandle } from './HarnessSystemPromptsTab';
import { type MetricsIgnoredExtsTabHandle } from './MetricsIgnoredExtsTab';
import { type AgentsTabHandle } from './AgentsTab';
import { type PiTabHandle } from './PiTab';
import { type McpTabHandle } from './McpTab';
import { type ToolsTabHandle } from './ToolsTab';

// The parent-owned draft values that participate in a save.
type SaveDrafts = {
  terminalDefaultHarness: TerminalDefaultHarness;
  terminalClaudeSkipPermissions: boolean;
  codexYolo: boolean;
  instrumentClaude: boolean;
  disableMemory: boolean;
  qaTerminalAutoClose: boolean;
  restoreTerminalsOnOpen: RestoreTerminalsMode;
  restoreNudgeAgents: boolean;
  restoreNudgeUserTabs: boolean;
};

// Imperative handles for each tab. Each may be null if its tab hasn't
// mounted yet; the save reads patches defensively.
type SaveHandles = {
  startupTerminals: StartupTerminalsTabHandle | null;
  envNotes: EnvNotesTabHandle | null;
  instructionTemplates: InstructionTemplatesTabHandle | null;
  harnessSystemPrompts: HarnessSystemPromptsTabHandle | null;
  metricsIgnoredExts: MetricsIgnoredExtsTabHandle | null;
  agents: AgentsTabHandle | null;
  pi: PiTabHandle | null;
  mcp: McpTabHandle | null;
  tools: ToolsTabHandle | null;
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

// The machine-global half of a save (Agents' max-agents, the Pi tab's
// providers + model menu, Tools' pack enables). Separate from the per-project
// half because these tabs are editable with NO project open — the dialog then
// saves only this half instead of silently doing nothing. (The Pi providers +
// model menu come from the Pi tab; max-agents from Agents. The backend
// reconciles piProviders into ~/.pi/agent/models.json.)
export async function saveGlobalSettings(
  handles: Pick<SaveHandles, 'agents' | 'pi' | 'tools'>,
): Promise<void> {
  const maxAgentsPatch = handles.agents?.getMaxConcurrentAgentsPatch();
  const piProvidersPatch = handles.pi?.getPiProvidersPatch();
  const piModelMenuPatch = handles.pi?.getPiModelMenuPatch();
  const opengrepGlobalPatch = handles.tools?.getOpengrepGlobalPatch();
  const globalPatch: Parameters<typeof patchGlobalSettings>[0] = {};
  if (maxAgentsPatch !== undefined) globalPatch.maxConcurrentAgents = maxAgentsPatch;
  if (piProvidersPatch !== undefined) globalPatch.piProviders = piProvidersPatch;
  if (piModelMenuPatch !== undefined) globalPatch.piModelMenu = piModelMenuPatch;
  if (opengrepGlobalPatch !== undefined) globalPatch.opengrep = opengrepGlobalPatch;
  if (Object.keys(globalPatch).length === 0) return;
  await patchGlobalSettings(globalPatch);
  // The Pi providers/menu feed the curated "Pi — X" dropdowns. If either
  // changed, refresh the shared menu cache so every mounted dropdown (task
  // board, workflow steps, post-merge hook, sidebar) updates without a reload.
  if (piProvidersPatch !== undefined || piModelMenuPatch !== undefined) {
    void notifyPiModelsChanged();
  }
}

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
    codexYolo: drafts.codexYolo,
  };
  const patch: Partial<UserSettings> = {
    startupTerminals: cleaned,
    ...terminalLaunchPatch,
    instrumentProjectClaudeSessions: drafts.instrumentClaude,
    disableClaudeMemory: drafts.disableMemory,
    qaTerminalAutoClose: drafts.qaTerminalAutoClose,
    restoreTerminalsOnOpen: drafts.restoreTerminalsOnOpen,
    restoreNudgeAgents: drafts.restoreNudgeAgents,
    restoreNudgeUserTabs: drafts.restoreNudgeUserTabs,
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
  // Per-harness system-prompt overrides (same clobber-guard: the patch is the
  // full desired map, only present once the editor has loaded and been edited).
  const harnessSystemPromptsPatch =
    handles.harnessSystemPrompts?.getHarnessSystemPromptsPatch();
  if (harnessSystemPromptsPatch !== undefined) {
    patch.harnessSystemPrompts = harnessSystemPromptsPatch;
  }
  const metricsExtsPatch = handles.metricsIgnoredExts?.getMetricsIgnoredExtsPatch();
  if (metricsExtsPatch !== undefined) {
    patch.metricsIgnoredExts = metricsExtsPatch;
  }
  // MCP per-project enables (mcpOverrides + qaPlaywright). Secrets / imports /
  // custom-server defs persist on their own immediately, so they're not here.
  const mcpPatch = handles.mcp?.getMcpUserPatch();
  if (mcpPatch !== undefined) Object.assign(patch, mcpPatch);
  // Opengrep per-project scan filter (Settings → Tools). Engine / pack installs
  // happen immediately from the tab; only the settings wait for Save.
  const opengrepProjectPatch = handles.tools?.getOpengrepProjectPatch();
  if (opengrepProjectPatch !== undefined) patch.opengrep = opengrepProjectPatch;

  // 2. Persist the project user settings.
  await patchUserSettings(activeFolder, patch);

  // 3. Apply the install/remove of project hooks per the just-saved toggle.
  void ensureProjectInstrumentation(activeFolder);

  // 4. Machine-global settings go to a separate endpoint, not userSettings.
  await saveGlobalSettings(handles);

  // 5. Notify the parent callbacks.
  onStartupTerminalsChange(cleaned);
  onTerminalLaunchSettingsChange(terminalLaunchPatch);
  if (metricsExtsPatch !== undefined) {
    await onMetricsIgnoredExtsChange(metricsExtsPatch);
  }
}
