import { useState } from 'react';
import { TerminalSquare, ScrollText, BarChart3, Cpu, Plug, Server } from 'lucide-react';
import { Modal } from './Modal';
import {
  type StartupTerminal,
  type TerminalDefaultHarness,
  type TerminalLaunchSettings,
} from '../api';
import { StartupTerminalsTab } from './settings/StartupTerminalsTab';
import { SettingsInfo } from './settings/SettingsInfo';
import { EnvNotesTab } from './settings/EnvNotesTab';
import { MetricsIgnoredExtsTab } from './settings/MetricsIgnoredExtsTab';
import { AgentsTab } from './settings/AgentsTab';
import { PiTab } from './settings/PiTab';
import { McpTab } from './settings/McpTab';
import { InstructionTemplatesTab } from './settings/InstructionTemplatesTab';
import { useSettingsDrafts } from './settings/useSettingsDrafts';
import { useSettingsController, type Tab } from './settings/useSettingsController';

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
          <div className="settings-section-title-row">
            <div className="settings-section-title">New terminal default</div>
            <SettingsInfo label="About the new terminal default">
              <p>
                Choose what the terminal panel’s + button opens by default. The
                chevron menu still lets you pick a different terminal for one-off
                launches.
              </p>
            </SettingsInfo>
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
          <div className="settings-section-title-row">
            <div className="settings-section-title">Show Claude sessions on the graph</div>
            <SettingsInfo label="About showing Claude sessions on the graph">
              <p>
                Adds activity hooks to this project’s{' '}
                <code>.claude/settings.local.json</code> so any Claude session
                working in this project — even ones you launch yourself in a
                terminal — appears as an orange node with focus beams.
              </p>
              <p>
                Your own Claude config is preserved; turning this off removes
                Lattice’s hooks. Sessions must be (re)started to pick up the
                change.
              </p>
            </SettingsInfo>
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
          <div className="settings-section-title-row">
            <div className="settings-section-title">Turn off Claude memory for this project</div>
            <SettingsInfo label="About turning off Claude memory">
              <p>
                Disables Claude Code’s auto-memory for this project — both the
                agents Lattice runs in worktrees and any Claude session you start
                yourself in the project tree. Recommended when running many
                agents in parallel, since they would otherwise share and thrash
                one project memory store.
              </p>
              <p>
                Written per-project (the project’s{' '}
                <code>.claude/settings.local.json</code> plus an env var on
                spawned agents); your machine-global Claude memory in other
                projects is left untouched.
              </p>
            </SettingsInfo>
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
          <div className="settings-section-title-row">
            <div className="settings-section-title">QA e2e test terminal</div>
            <SettingsInfo label="About the QA e2e test terminal">
              <p>
                When a QA-lane end-to-end (Playwright) test finishes, its
                terminal stays open by default so you can read the PASS/FAIL
                verdict and output. Enable this to auto-close it the moment the
                run completes.
              </p>
              <p>
                The task’s qa&nbsp;→&nbsp;done auto-advance is unaffected either
                way.
              </p>
            </SettingsInfo>
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
  const drafts = useSettingsDrafts(open, activeFolder, terminalLaunchSettings);
  const { refs, saving, error, dirtyByTab, bumpDirty, save, requestClose } =
    useSettingsController({
      open,
      activeFolder,
      drafts,
      startupTerminals,
      onClose,
      onStartupTerminalsChange,
      onTerminalLaunchSettingsChange,
      onMetricsIgnoredExtsChange,
    });

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
            ref={refs.startupTerminals}
            active={tab === 'terminals'}
            open={open}
            startupTerminals={startupTerminals}
          />
          <InstructionTemplatesTab
            ref={refs.instructionTemplates}
            active={tab === 'prompts'}
            open={open}
            activeFolder={activeFolder}
          />
          <EnvNotesTab
            ref={refs.envNotes}
            active={tab === 'prompts'}
            open={open}
            activeFolder={activeFolder}
          />
          <MetricsIgnoredExtsTab
            ref={refs.metricsIgnoredExts}
            active={tab === 'metrics'}
            open={open}
            metricsIgnoredExts={metricsIgnoredExts}
          />
          <AgentsTab ref={refs.agents} active={tab === 'agents'} open={open} />
          <PiTab ref={refs.pi} active={tab === 'pi'} open={open} />
          <McpTab
            ref={refs.mcp}
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
