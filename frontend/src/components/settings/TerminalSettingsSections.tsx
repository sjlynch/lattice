import { type TerminalDefaultHarness } from '../../api';
import { SettingsInfo } from './SettingsInfo';
import type { SettingsDrafts } from './useSettingsDrafts';

// The project/terminal settings sections that make up the top of the Terminals
// tab. They are driven entirely by the parent-owned drafts in
// `useSettingsDrafts`, so they need no imperative save handle (unlike the
// forwardRef tab panels) — `SettingsDialog` just hands them the draft slice.

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

// The Terminals tab's project-settings block: the four sections above, wired to
// the parent draft slice. Composed by `SettingsDialog` ahead of the
// `StartupTerminalsTab` panel.
export function TerminalSettingsSections({ drafts }: { drafts: SettingsDrafts }) {
  return (
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
  );
}
