import { useCallback, useEffect, useRef, useState } from 'react';
import { useConfirm } from '../shared/ConfirmDialog';
import {
  type StartupTerminal,
  type TerminalLaunchSettings,
} from '../../api';
import {
  cleanStartupTerminals,
  type StartupTerminalsTabHandle,
} from './StartupTerminalsTab';
import { type EnvNotesTabHandle } from './EnvNotesTab';
import { type InstructionTemplatesTabHandle } from './InstructionTemplatesTab';
import { type MetricsIgnoredExtsTabHandle } from './MetricsIgnoredExtsTab';
import { type AgentsTabHandle } from './AgentsTab';
import { type PiTabHandle } from './PiTab';
import { type McpTabHandle } from './McpTab';
import { saveSettings } from './saveSettings';
import { type SettingsDrafts } from './useSettingsDrafts';

export type Tab = 'terminals' | 'prompts' | 'metrics' | 'agents' | 'pi' | 'mcp';

const EMPTY_DIRTY: Record<Tab, boolean> = {
  terminals: false,
  prompts: false,
  metrics: false,
  agents: false,
  pi: false,
  mcp: false,
};

type SettingsControllerParams = {
  open: boolean;
  activeFolder: string;
  drafts: SettingsDrafts;
  startupTerminals: StartupTerminal[];
  onClose: () => void;
  onStartupTerminalsChange: (next: StartupTerminal[]) => void;
  onTerminalLaunchSettingsChange: (next: TerminalLaunchSettings) => void;
  onMetricsIgnoredExtsChange: (next: string[]) => void | Promise<void>;
};

// Owns everything about the Settings modal that isn't tab chrome or body
// rendering: the per-tab imperative handles, the derived per-tab dirty map,
// the save orchestration (delegating to `saveSettings`), and the
// warn-on-unsaved-close flow. The dialog spreads `refs` onto each tab panel
// and renders the returned state; it carries no save/dirty logic itself.
export function useSettingsController({
  open,
  activeFolder,
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
  const metricsIgnoredExtsRef = useRef<MetricsIgnoredExtsTabHandle>(null);
  const agentsRef = useRef<AgentsTabHandle>(null);
  const piRef = useRef<PiTabHandle>(null);
  const mcpRef = useRef<McpTabHandle>(null);
  const { confirmUnsaved } = useConfirm();
  const closingRef = useRef(false);

  useEffect(() => {
    if (open) setError(null);
  }, [open, startupTerminals]);

  // Per-tab dirty: a tab is dirty when its patch getter would write something
  // (returns non-undefined) or, for the parent-owned drafts / startup
  // terminals, when the draft differs from what was loaded. MCP secrets are
  // intentionally excluded — they auto-save on their own, outside Save.
  const computeDirty = useCallback((): Record<Tab, boolean> => {
    const startupDirty =
      JSON.stringify(
        startupTerminalsRef.current?.getCleanedTerminals() ??
          cleanStartupTerminals(startupTerminals),
      ) !== JSON.stringify(cleanStartupTerminals(startupTerminals));
    return {
      terminals: drafts.dirty || startupDirty,
      prompts:
        instructionTemplatesRef.current?.getInstructionTemplateOverridesPatch() !==
          undefined ||
        envNotesRef.current?.getWorktreeEnvNotesPatch() !== undefined,
      metrics:
        metricsIgnoredExtsRef.current?.getMetricsIgnoredExtsPatch() !== undefined,
      agents: agentsRef.current?.getMaxConcurrentAgentsPatch() !== undefined,
      pi:
        piRef.current?.getPiProvidersPatch() !== undefined ||
        piRef.current?.getPiModelMenuPatch() !== undefined,
      mcp: mcpRef.current?.getMcpUserPatch() !== undefined,
    };
  }, [drafts.dirty, startupTerminals]);

  // The imperative patch getters aren't reactive, so re-derive the dirty map
  // after any edit inside the dialog body. The bump (onChange/onClick on the
  // body) re-renders us; reading the refs in this post-commit effect avoids the
  // one-tick staleness of reading them during render.
  const [dirtyByTab, setDirtyByTab] = useState<Record<Tab, boolean>>(EMPTY_DIRTY);
  const [dirtyTick, setDirtyTick] = useState(0);
  useEffect(() => {
    if (!open) {
      setDirtyByTab(EMPTY_DIRTY);
      return;
    }
    const next = computeDirty();
    setDirtyByTab((prev) =>
      (Object.keys(next) as Tab[]).every((id) => prev[id] === next[id])
        ? prev
        : next,
    );
  }, [open, dirtyTick, computeDirty]);
  const bumpDirty = useCallback(() => setDirtyTick((t) => t + 1), []);

  const save = async () => {
    if (!activeFolder) return;
    setSaving(true);
    setError(null);
    try {
      await saveSettings({
        activeFolder,
        startupTerminals,
        drafts: {
          terminalDefaultHarness: drafts.terminalDefaultHarness,
          terminalClaudeSkipPermissions: drafts.terminalClaudeSkipPermissions,
          instrumentClaude: drafts.instrumentClaude,
          disableMemory: drafts.disableMemory,
          qaTerminalAutoClose: drafts.qaTerminalAutoClose,
        },
        handles: {
          startupTerminals: startupTerminalsRef.current,
          envNotes: envNotesRef.current,
          instructionTemplates: instructionTemplatesRef.current,
          metricsIgnoredExts: metricsIgnoredExtsRef.current,
          agents: agentsRef.current,
          pi: piRef.current,
          mcp: mcpRef.current,
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

  // Every close path (Cancel, Escape, backdrop) routes here. With pending edits
  // across any tab, ask Save / Discard / Cancel first instead of silently
  // dropping them. (MCP secrets aren't in the dirty check — they auto-save.)
  const requestClose = async () => {
    if (saving || closingRef.current) return;
    if (!Object.values(computeDirty()).some(Boolean)) {
      onClose();
      return;
    }
    closingRef.current = true;
    try {
      const choice = await confirmUnsaved({
        message: 'You have unsaved settings changes.',
      });
      if (choice === 'cancel') return;
      if (choice === 'discard') {
        onClose();
        return;
      }
      // save() closes on success (onClose) and surfaces an error + stays open
      // on failure.
      await save();
    } finally {
      closingRef.current = false;
    }
  };

  return {
    refs: {
      startupTerminals: startupTerminalsRef,
      envNotes: envNotesRef,
      instructionTemplates: instructionTemplatesRef,
      metricsIgnoredExts: metricsIgnoredExtsRef,
      agents: agentsRef,
      pi: piRef,
      mcp: mcpRef,
    },
    saving,
    error,
    dirtyByTab,
    bumpDirty,
    save,
    requestClose,
  };
}
