import { useCallback, useEffect, useState, type RefObject } from 'react';
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
import { type SettingsDrafts } from './useSettingsDrafts';
import { type Tab } from './settingsTabs';
import { type StartupTerminal } from '../../api';

export const EMPTY_DIRTY: Record<Tab, boolean> = {
  terminals: false,
  prompts: false,
  metrics: false,
  agents: false,
  pi: false,
  mcp: false,
};

export type SettingsTabRefs = {
  startupTerminals: RefObject<StartupTerminalsTabHandle | null>;
  envNotes: RefObject<EnvNotesTabHandle | null>;
  instructionTemplates: RefObject<InstructionTemplatesTabHandle | null>;
  metricsIgnoredExts: RefObject<MetricsIgnoredExtsTabHandle | null>;
  agents: RefObject<AgentsTabHandle | null>;
  pi: RefObject<PiTabHandle | null>;
  mcp: RefObject<McpTabHandle | null>;
};

type SettingsDirtyParams = {
  open: boolean;
  drafts: SettingsDrafts;
  startupTerminals: StartupTerminal[];
  refs: SettingsTabRefs;
};

// Owns the Settings dialog's derived dirty state. Most tab panels expose only
// imperative patch getters, so the dialog bumps a cheap tick after body edits
// and this hook re-reads the handles after React commits.
export function useSettingsDirty({
  open,
  drafts,
  startupTerminals,
  refs,
}: SettingsDirtyParams) {
  const computeDirty = useCallback((): Record<Tab, boolean> => {
    const cleanedStartupTerminals = cleanStartupTerminals(startupTerminals);
    const startupDirty =
      JSON.stringify(
        refs.startupTerminals.current?.getCleanedTerminals() ??
          cleanedStartupTerminals,
      ) !== JSON.stringify(cleanedStartupTerminals);

    return {
      terminals: drafts.dirty || startupDirty,
      prompts:
        refs.instructionTemplates.current?.getInstructionTemplateOverridesPatch() !==
          undefined || refs.envNotes.current?.getWorktreeEnvNotesPatch() !== undefined,
      metrics:
        refs.metricsIgnoredExts.current?.getMetricsIgnoredExtsPatch() !== undefined,
      agents: refs.agents.current?.getMaxConcurrentAgentsPatch() !== undefined,
      pi:
        refs.pi.current?.getPiProvidersPatch() !== undefined ||
        refs.pi.current?.getPiModelMenuPatch() !== undefined,
      mcp: refs.mcp.current?.getMcpUserPatch() !== undefined,
    };
  }, [drafts.dirty, refs, startupTerminals]);

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

  return { dirtyByTab, bumpDirty, computeDirty };
}
