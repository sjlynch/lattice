import { useCallback, useEffect, useRef, useState } from 'react';
import { TerminalSquare, ScrollText, BarChart3, Cpu, Plug, Server } from 'lucide-react';
import { Modal } from './Modal';
import { useConfirm } from './shared/ConfirmDialog';
import {
  type StartupTerminal,
  type TerminalDefaultHarness,
  type TerminalLaunchSettings,
} from '../api';
import {
  cleanStartupTerminals,
  StartupTerminalsTab,
  type StartupTerminalsTabHandle,
} from './settings/StartupTerminalsTab';
import {
  EnvNotesTab,
  type EnvNotesTabHandle,
} from './settings/EnvNotesTab';
import {
  MetricsIgnoredExtsTab,
  type MetricsIgnoredExtsTabHandle,
} from './settings/MetricsIgnoredExtsTab';
import { AgentsTab, type AgentsTabHandle } from './settings/AgentsTab';
import { PiTab, type PiTabHandle } from './settings/PiTab';
import { McpTab, type McpTabHandle } from './settings/McpTab';
import {
  InstructionTemplatesTab,
  type InstructionTemplatesTabHandle,
} from './settings/InstructionTemplatesTab';
import { useSettingsDrafts } from './settings/useSettingsDrafts';
import { saveSettings } from './settings/saveSettings';

type Props = {
  open: boolean;
  onClose: () => void;
  activeFolder: string;
  startupTerminals: StartupTerminal[];
  onStartupTerminalsChange: (next: StartupTerminal[]) => void;
  terminalLaunchSettings: TerminalLaunchSettings;
  onTerminalLaunchSettingsChange: (next: TerminalLaunchSettings) => void;
  metricsIgnoredExts: string[];
  onMetricsIgnoredExtsChange: (next: string[]) => void | Promise<void>;
};

type Tab = 'terminals' | 'prompts' | 'metrics' | 'agents' | 'pi' | 'mcp';

// Scope tells the user whether a tab's settings are machine-global (apply to
// every project on this machine — Agents' max-agents, Pi endpoints/model menu)
// or per-project (only the active folder). Drives the per-tab scope badge.
type TabScope = 'global' | 'project';

const TAB_META: {
  id: Tab;
  label: string;
  Icon: typeof TerminalSquare;
  scope: TabScope;
}[] = [
  { id: 'terminals', label: 'Terminals', Icon: TerminalSquare, scope: 'project' },
  { id: 'prompts', label: 'Agent prompts', Icon: ScrollText, scope: 'project' },
  { id: 'metrics', label: 'Metrics', Icon: BarChart3, scope: 'project' },
  { id: 'agents', label: 'Agents', Icon: Cpu, scope: 'global' },
  { id: 'pi', label: 'Pi', Icon: Server, scope: 'global' },
  { id: 'mcp', label: 'MCP', Icon: Plug, scope: 'project' },
];

const EMPTY_DIRTY: Record<Tab, boolean> = {
  terminals: false,
  prompts: false,
  metrics: false,
  agents: false,
  pi: false,
  mcp: false,
};

const TERMINAL_DEFAULT_OPTIONS: { value: TerminalDefaultHarness; label: string }[] = [
  { value: 'claude', label: 'Claude' },
  { value: 'pi', label: 'Pi' },
  { value: 'codex', label: 'Codex' },
  { value: 'terminal', label: 'Plain terminal' },
];

type TerminalDefaultSettingsSectionProps = {
  terminalDefaultHarness: TerminalDefaultHarness;
  terminalClaudeSkipPermissions: boolean;
  onTerminalDefaultHarnessChange: (value: TerminalDefaultHarness) => void;
  onTerminalClaudeSkipPermissionsChange: (value: boolean) => void;
};

function TerminalDefaultSettingsSection({
  terminalDefaultHarness,
  terminalClaudeSkipPermissions,
  onTerminalDefaultHarnessChange,
  onTerminalClaudeSkipPermissionsChange,
}: TerminalDefaultSettingsSectionProps) {
  return (
    <div className="settings-section">
      <div className="settings-section-header">
        <div>
          <div className="settings-section-title">New terminal default</div>
          <div className="settings-section-sub">
            Choose what the terminal panel’s + button opens by default. The
            chevron menu still lets you pick a different terminal for one-off
            launches.
          </div>
        </div>
      </div>
      <div className="settings-control-row">
        <label className="settings-control-label" htmlFor="terminal-default-harness">
          Default harness
        </label>
        <select
          id="terminal-default-harness"
          className="settings-select"
          value={terminalDefaultHarness}
          onChange={(e) =>
            onTerminalDefaultHarnessChange(e.target.value as TerminalDefaultHarness)
          }
        >
          {TERMINAL_DEFAULT_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </div>
      {terminalDefaultHarness === 'claude' && (
        <label className="settings-checkbox-row">
          <input
            type="checkbox"
            checked={terminalClaudeSkipPermissions}
            onChange={(e) => onTerminalClaudeSkipPermissionsChange(e.target.checked)}
          />
          <span>Launch Claude with --dangerously-skip-permissions</span>
        </label>
      )}
    </div>
  );
}

type ClaudeInstrumentationSectionProps = {
  enabled: boolean;
  onChange: (value: boolean) => void;
};

function ClaudeInstrumentationSection({
  enabled,
  onChange,
}: ClaudeInstrumentationSectionProps) {
  return (
    <div className="settings-section">
      <div className="settings-section-header">
        <div>
          <div className="settings-section-title">Show Claude sessions on the graph</div>
          <div className="settings-section-sub">
            Adds activity hooks to this project’s{' '}
            <code>.claude/settings.local.json</code> so any Claude session
            working in this project — even ones you launch yourself in a
            terminal — appears as an orange node with focus beams. Your own
            Claude config is preserved; turning this off removes Lattice’s
            hooks. Sessions must be (re)started to pick up the change.
          </div>
        </div>
      </div>
      <label className="settings-checkbox-row">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => onChange(e.target.checked)}
        />
        <span>Instrument Claude sessions in this project</span>
      </label>
    </div>
  );
}

type ClaudeMemorySectionProps = {
  disabled: boolean;
  onChange: (value: boolean) => void;
};

function ClaudeMemorySection({ disabled, onChange }: ClaudeMemorySectionProps) {
  return (
    <div className="settings-section">
      <div className="settings-section-header">
        <div>
          <div className="settings-section-title">Turn off Claude memory for this project</div>
          <div className="settings-section-sub">
            Disables Claude Code’s auto-memory for this project — both the agents
            Lattice runs in worktrees and any Claude session you start yourself
            in the project tree. Recommended when running many agents in
            parallel, since they would otherwise share and thrash one project
            memory store. Written per-project (the project’s{' '}
            <code>.claude/settings.local.json</code> plus an env var on spawned
            agents); your machine-global Claude memory in other projects is left
            untouched.
          </div>
        </div>
      </div>
      <label className="settings-checkbox-row">
        <input
          type="checkbox"
          checked={disabled}
          onChange={(e) => onChange(e.target.checked)}
        />
        <span>Disable Claude auto-memory for this project</span>
      </label>
    </div>
  );
}

type QaTerminalSectionProps = {
  autoClose: boolean;
  onChange: (value: boolean) => void;
};

function QaTerminalSection({ autoClose, onChange }: QaTerminalSectionProps) {
  return (
    <div className="settings-section">
      <div className="settings-section-header">
        <div>
          <div className="settings-section-title">QA e2e test terminal</div>
          <div className="settings-section-sub">
            When a QA-lane end-to-end (Playwright) test finishes, its terminal
            stays open by default so you can read the PASS/FAIL verdict and
            output. Enable this to auto-close it the moment the run completes.
            The task’s qa&nbsp;→&nbsp;done auto-advance is unaffected either way.
          </div>
        </div>
      </div>
      <label className="settings-checkbox-row">
        <input
          type="checkbox"
          checked={autoClose}
          onChange={(e) => onChange(e.target.checked)}
        />
        <span>Auto-close the QA e2e terminal when its run finishes</span>
      </label>
    </div>
  );
}

export function SettingsDialog({
  open,
  onClose,
  activeFolder,
  startupTerminals,
  onStartupTerminalsChange,
  terminalLaunchSettings,
  onTerminalLaunchSettingsChange,
  metricsIgnoredExts,
  onMetricsIgnoredExtsChange,
}: Props) {
  const [tab, setTab] = useState<Tab>('terminals');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const drafts = useSettingsDrafts(open, activeFolder, terminalLaunchSettings);
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
      TAB_META.every((t) => prev[t.id] === next[t.id]) ? prev : next,
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

  return (
    <Modal open={open} onClose={requestClose} width={620}>
      <div className="modal-header">Settings</div>
      <div className="settings-scope-note">
        Global settings apply to all projects on this machine; per-project
        settings affect only the active folder.
      </div>
      <div className="settings-body">
        <div className="settings-tabs">
          {TAB_META.map(({ id, label, Icon, scope }) => (
            <button
              key={id}
              className={`settings-tab ${tab === id ? 'active' : ''}`}
              onClick={() => setTab(id)}
              title={
                scope === 'global'
                  ? 'Machine-global — applies to all projects'
                  : 'Per-project — applies to the active folder'
              }
            >
              <Icon size={12} />
              {label}
              <span
                className={`settings-tab-scope ${scope}`}
                aria-label={scope === 'global' ? 'Global setting' : 'Per-project setting'}
              >
                {scope === 'global' ? 'Global' : 'Project'}
              </span>
              {dirtyByTab[id] && (
                <span className="settings-tab-dirty" aria-label="Unsaved changes" />
              )}
            </button>
          ))}
        </div>
        <div
          className="settings-tab-body"
          onChange={bumpDirty}
          onClick={bumpDirty}
        >
          {tab === 'terminals' && (
            <>
              <TerminalDefaultSettingsSection
                terminalDefaultHarness={drafts.terminalDefaultHarness}
                terminalClaudeSkipPermissions={drafts.terminalClaudeSkipPermissions}
                onTerminalDefaultHarnessChange={drafts.setTerminalDefaultHarness}
                onTerminalClaudeSkipPermissionsChange={drafts.setTerminalClaudeSkipPermissions}
              />
              <ClaudeInstrumentationSection
                enabled={drafts.instrumentClaude}
                onChange={drafts.setInstrumentClaude}
              />
              <ClaudeMemorySection
                disabled={drafts.disableMemory}
                onChange={drafts.setDisableMemory}
              />
              <QaTerminalSection
                autoClose={drafts.qaTerminalAutoClose}
                onChange={drafts.setQaTerminalAutoClose}
              />
            </>
          )}
          <StartupTerminalsTab
            ref={startupTerminalsRef}
            active={tab === 'terminals'}
            open={open}
            startupTerminals={startupTerminals}
          />
          <InstructionTemplatesTab
            ref={instructionTemplatesRef}
            active={tab === 'prompts'}
            open={open}
            activeFolder={activeFolder}
          />
          <EnvNotesTab
            ref={envNotesRef}
            active={tab === 'prompts'}
            open={open}
            activeFolder={activeFolder}
          />
          <MetricsIgnoredExtsTab
            ref={metricsIgnoredExtsRef}
            active={tab === 'metrics'}
            open={open}
            metricsIgnoredExts={metricsIgnoredExts}
          />
          <AgentsTab ref={agentsRef} active={tab === 'agents'} open={open} />
          <PiTab ref={piRef} active={tab === 'pi'} open={open} />
          <McpTab
            ref={mcpRef}
            active={tab === 'mcp'}
            open={open}
            activeFolder={activeFolder}
          />
        </div>
      </div>
      {error && <div className="error-msg" style={{ margin: '0 16px' }}>{error}</div>}
      <div className="modal-footer">
        <button className="btn-ghost" onClick={requestClose} disabled={saving}>
          Cancel
        </button>
        <button
          className="btn-primary"
          onClick={save}
          disabled={saving || !activeFolder}
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </Modal>
  );
}
