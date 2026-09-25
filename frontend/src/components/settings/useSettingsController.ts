import { useEffect, useMemo, useRef, useState } from 'react';
import {
  type StartupTerminal,
  type TerminalLaunchSettings,
} from '../../api';
import { type StartupTerminalsTabHandle } from './StartupTerminalsTab';
import { type EnvNotesTabHandle } from './EnvNotesTab';
import { type InstructionTemplatesTabHandle } from './InstructionTemplatesTab';
import { type HarnessSystemPromptsTabHandle } from './HarnessSystemPromptsTab';
import { type MetricsIgnoredExtsTabHandle } from './MetricsIgnoredExtsTab';
import { type AgentsTabHandle } from './AgentsTab';
import { type PiTabHandle } from './PiTab';
import { type McpTabHandle } from './McpTab';
import { type ToolsTabHandle } from './ToolsTab';
import { saveGlobalSettings, saveSettings } from './saveSettings';
import { type SettingsDrafts } from './useSettingsDrafts';
import { useSettingsDirty } from './useSettingsDirty';
import { useSettingsCloseFlow } from './useSettingsCloseFlow';

export type { Tab } from './settingsTabs';

type SettingsControllerParams = {
  open: boolean;
  activeFolder: string;
  // App's `userSettings.loaded` — gates the save of the fields seeded from it.
  settingsLoaded: boolean;
  drafts: SettingsDrafts;
  startupTerminals: StartupTerminal[];
  onClose: () => void;
  onStartupTerminalsChange: (next: StartupTerminal[]) => void;
  onTerminalLaunchSettingsChange: (next: TerminalLaunchSettings) => void;
  onMetricsIgnoredExtsChange: (next: string[]) => void | Promise<void>;
};

// Owns the Settings modal's per-tab imperative handles and save orchestration.
// Focused hooks below derive the dirty map and gate the warn-on-unsaved-close
// flow, keeping this controller as the coordinator the dialog consumes.
export function useSettingsController({
  open,
  activeFolder,
  settingsLoaded,
  drafts,
  startupTerminals,
  onClose,
  onStartupTerminalsChange,
  onTerminalLaunchSettingsChange,
  onMetricsIgnoredExtsChange,
}: SettingsControllerParams) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const startupTerminalsRef = useRef<StartupTerminalsTabHandle>(null);
  const envNotesRef = useRef<EnvNotesTabHandle>(null);
  const instructionTemplatesRef = useRef<InstructionTemplatesTabHandle>(null);
  const harnessSystemPromptsRef = useRef<HarnessSystemPromptsTabHandle>(null);
  const metricsIgnoredExtsRef = useRef<MetricsIgnoredExtsTabHandle>(null);
  const agentsRef = useRef<AgentsTabHandle>(null);
  const piRef = useRef<PiTabHandle>(null);
  const mcpRef = useRef<McpTabHandle>(null);
  const toolsRef = useRef<ToolsTabHandle>(null);
  const refs = useMemo(
    () => ({
      startupTerminals: startupTerminalsRef,
      envNotes: envNotesRef,
      instructionTemplates: instructionTemplatesRef,
      harnessSystemPrompts: harnessSystemPromptsRef,
      metricsIgnoredExts: metricsIgnoredExtsRef,
      agents: agentsRef,
      pi: piRef,
      mcp: mcpRef,
      tools: toolsRef,
    }),
    [
      agentsRef,
      envNotesRef,
      harnessSystemPromptsRef,
      instructionTemplatesRef,
      mcpRef,
      metricsIgnoredExtsRef,
      piRef,
      startupTerminalsRef,
      toolsRef,
    ],
  );

  useEffect(() => {
    if (open) setError(null);
  }, [open, startupTerminals]);

  const { dirtyByTab, bumpDirty, computeDirty } = useSettingsDirty({
    open,
    drafts,
    startupTerminals,
    refs,
  });

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      if (!activeFolder) {
        // No project open: the per-project tabs are read-only, but the
        // machine-global ones (Agents / Pi / Tools packs) are not. Save that
        // half; a silent return here used to strand the dialog on "Save".
        await saveGlobalSettings({
          agents: agentsRef.current,
          pi: piRef.current,
          tools: toolsRef.current,
        });
        onClose();
        return;
      }
      await saveSettings({
        activeFolder,
        settingsLoaded,
        startupTerminals,
        drafts: {
          terminalDefaultHarness: drafts.terminalDefaultHarness,
          terminalClaudeSkipPermissions: drafts.terminalClaudeSkipPermissions,
          codexYolo: drafts.codexYolo,
          terminalLaunchTouched: drafts.getTerminalLaunchTouched(),
          // Only the fetched toggles that loaded or were edited — an
          // unloaded, untouched one would write its default over the
          // project's saved value.
          ...drafts.getSavableFetchedToggles(),
        },
        handles: {
          startupTerminals: startupTerminalsRef.current,
          envNotes: envNotesRef.current,
          instructionTemplates: instructionTemplatesRef.current,
          harnessSystemPrompts: harnessSystemPromptsRef.current,
          metricsIgnoredExts: metricsIgnoredExtsRef.current,
          agents: agentsRef.current,
          pi: piRef.current,
          mcp: mcpRef.current,
          tools: toolsRef.current,
        },
        onStartupTerminalsChange,
        onTerminalLaunchSettingsChange,
        onMetricsIgnoredExtsChange,
      });
      onClose();
    } catch (err) {
      setError((err as Error).message || 'Failed to save settings');
    } finally {
      setSaving(false);
    }
  };

  const requestClose = useSettingsCloseFlow({
    saving,
    computeDirty,
    save,
    onClose,
  });

  return {
    refs,
    saving,
    error,
    dirtyByTab,
    bumpDirty,
    save,
    requestClose,
  };
}
