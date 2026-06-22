import { useEffect, useRef, useState } from 'react';
import { TerminalSquare, ScrollText, BarChart3, Cpu, Plug, Server } from 'lucide-react';
import { Modal } from './Modal';
import {
  type StartupTerminal,
  type TerminalDefaultHarness,
  type TerminalLaunchSettings,
} from '../api';
import {
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

  useEffect(() => {
    if (open) setError(null);
  }, [open, startupTerminals]);

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
            className={`settings-tab ${tab === 'prompts' ? 'active' : ''}`}
            onClick={() => setTab('prompts')}
          >
            <ScrollText size={12} />
            Agent prompts
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
          <button
            className={`settings-tab ${tab === 'pi' ? 'active' : ''}`}
            onClick={() => setTab('pi')}
          >
            <Server size={12} />
            Pi
          </button>
          <button
            className={`settings-tab ${tab === 'mcp' ? 'active' : ''}`}
            onClick={() => setTab('mcp')}
          >
            <Plug size={12} />
            MCP
          </button>
        </div>
        <div className="settings-tab-body">
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
