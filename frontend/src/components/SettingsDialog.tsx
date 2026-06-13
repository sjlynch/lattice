import { useEffect, useRef, useState } from 'react';
import { TerminalSquare, FileText, BarChart3, Cpu } from 'lucide-react';
import { Modal } from './Modal';
import {
  ensureProjectInstrumentation,
  fetchUserSettings,
  patchGlobalSettings,
  patchUserSettings,
  type StartupTerminal,
  type TerminalDefaultHarness,
  type TerminalLaunchSettings,
  type UserSettings,
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

type Tab = 'terminals' | 'env' | 'metrics' | 'agents';

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
  const [terminalDefaultHarnessDraft, setTerminalDefaultHarnessDraft] =
    useState<TerminalDefaultHarness>(terminalLaunchSettings.terminalDefaultHarness);
  const [terminalClaudeSkipPermissionsDraft, setTerminalClaudeSkipPermissionsDraft] =
    useState(terminalLaunchSettings.terminalClaudeSkipPermissions);
  // Default ON (opt-out) — absent setting counts as enabled.
  const [instrumentClaudeDraft, setInstrumentClaudeDraft] = useState(true);
  const startupTerminalsRef = useRef<StartupTerminalsTabHandle>(null);
  const envNotesRef = useRef<EnvNotesTabHandle>(null);
  const metricsIgnoredExtsRef = useRef<MetricsIgnoredExtsTabHandle>(null);
  const agentsRef = useRef<AgentsTabHandle>(null);

  useEffect(() => {
    if (open) setError(null);
  }, [open, startupTerminals]);

  useEffect(() => {
    if (!open) return;
    setTerminalDefaultHarnessDraft(terminalLaunchSettings.terminalDefaultHarness);
    setTerminalClaudeSkipPermissionsDraft(
      terminalLaunchSettings.terminalClaudeSkipPermissions,
    );
  }, [open, terminalLaunchSettings]);

  // The instrument toggle isn't part of terminalLaunchSettings, so fetch it
  // fresh when the dialog opens.
  useEffect(() => {
    if (!open || !activeFolder) return;
    let cancelled = false;
    fetchUserSettings(activeFolder)
      .then((s) => {
        if (!cancelled) {
          setInstrumentClaudeDraft(s.instrumentProjectClaudeSessions !== false);
        }
      })
      .catch(() => { /* keep current draft */ });
    return () => { cancelled = true; };
  }, [open, activeFolder]);

  const save = async () => {
    if (!activeFolder) return;
    setSaving(true);
    setError(null);
    try {
      const cleaned =
        startupTerminalsRef.current?.getCleanedTerminals() ??
        cleanStartupTerminals(startupTerminals);
      const terminalLaunchPatch: TerminalLaunchSettings = {
        terminalDefaultHarness: terminalDefaultHarnessDraft,
        terminalClaudeSkipPermissions: terminalClaudeSkipPermissionsDraft,
      };
      const patch: Partial<UserSettings> = {
        startupTerminals: cleaned,
        ...terminalLaunchPatch,
        instrumentProjectClaudeSessions: instrumentClaudeDraft,
      };
      // Only touch worktreeEnvNotes if the env fetch finished — otherwise we'd
      // overwrite the saved overrides with an empty map.
      const envNotesPatch = envNotesRef.current?.getWorktreeEnvNotesPatch();
      if (envNotesPatch !== undefined) patch.worktreeEnvNotes = envNotesPatch;
      const metricsExtsPatch =
        metricsIgnoredExtsRef.current?.getMetricsIgnoredExtsPatch();
      if (metricsExtsPatch !== undefined) {
        patch.metricsIgnoredExts = metricsExtsPatch;
      }
      await patchUserSettings(activeFolder, patch);
      // Apply the install/remove of project hooks per the just-saved toggle.
      void ensureProjectInstrumentation(activeFolder);
      // Machine-global settings go to a separate endpoint, not userSettings.
      const maxAgentsPatch = agentsRef.current?.getMaxConcurrentAgentsPatch();
      if (maxAgentsPatch !== undefined) {
        await patchGlobalSettings({ maxConcurrentAgents: maxAgentsPatch });
      }
      onStartupTerminalsChange(cleaned);
      onTerminalLaunchSettingsChange(terminalLaunchPatch);
      if (metricsExtsPatch !== undefined) {
        await onMetricsIgnoredExtsChange(metricsExtsPatch);
      }
      onClose();
    } catch (err) {
      setError((err as Error).message || 'Failed to save settings');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} width={620}>
      <div className="modal-header">Settings</div>
      <div className="settings-body">
        <div className="settings-tabs">
          <button
            className={`settings-tab ${tab === 'terminals' ? 'active' : ''}`}
            onClick={() => setTab('terminals')}
          >
            <TerminalSquare size={12} />
            Terminals
          </button>
          <button
            className={`settings-tab ${tab === 'env' ? 'active' : ''}`}
            onClick={() => setTab('env')}
          >
            <FileText size={12} />
            Agent instructions
          </button>
          <button
            className={`settings-tab ${tab === 'metrics' ? 'active' : ''}`}
            onClick={() => setTab('metrics')}
          >
            <BarChart3 size={12} />
            Metrics
          </button>
          <button
            className={`settings-tab ${tab === 'agents' ? 'active' : ''}`}
            onClick={() => setTab('agents')}
          >
            <Cpu size={12} />
            Agents
          </button>
        </div>
        <div className="settings-tab-body">
          {tab === 'terminals' && (
            <>
              <TerminalDefaultSettingsSection
                terminalDefaultHarness={terminalDefaultHarnessDraft}
                terminalClaudeSkipPermissions={terminalClaudeSkipPermissionsDraft}
                onTerminalDefaultHarnessChange={setTerminalDefaultHarnessDraft}
                onTerminalClaudeSkipPermissionsChange={setTerminalClaudeSkipPermissionsDraft}
              />
              <ClaudeInstrumentationSection
                enabled={instrumentClaudeDraft}
                onChange={setInstrumentClaudeDraft}
              />
            </>
          )}
          <StartupTerminalsTab
            ref={startupTerminalsRef}
            active={tab === 'terminals'}
            open={open}
            startupTerminals={startupTerminals}
          />
          <EnvNotesTab
            ref={envNotesRef}
            active={tab === 'env'}
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
        </div>
      </div>
      {error && <div className="error-msg" style={{ margin: '0 16px' }}>{error}</div>}
      <div className="modal-footer">
        <button className="btn-ghost" onClick={onClose} disabled={saving}>
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
