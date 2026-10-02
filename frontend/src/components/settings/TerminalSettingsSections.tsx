import { type RestoreTerminalsMode, type TerminalDefaultHarness } from '../../api';
import { CheckboxSettingsSection, SettingsSection } from './SettingsSection';
import { TERMINAL_TOGGLE_SECTIONS } from './terminalToggleSections';
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
    <SettingsSection
      title="New terminal default"
      infoLabel="About the new terminal default"
      info={(
        <p>
          Choose what the terminal panel’s + button opens by default. The chevron
          menu still lets you pick a different terminal for one-off launches.
        </p>
      )}
    >
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
    </SettingsSection>
  );
}

const RESTORE_MODE_OPTIONS: { value: RestoreTerminalsMode; label: string }[] = [
  { value: 'always', label: 'Always restore silently' },
  { value: 'ask', label: 'Ask first' },
  { value: 'never', label: 'Never (manual button only)' },
];

type RestoreSectionProps = {
  mode: RestoreTerminalsMode;
  nudgeAgents: boolean;
  nudgeUserTabs: boolean;
  onModeChange: (value: RestoreTerminalsMode) => void;
  onNudgeAgentsChange: (value: boolean) => void;
  onNudgeUserTabsChange: (value: boolean) => void;
};

function RestoreTerminalsSection({
  mode,
  nudgeAgents,
  nudgeUserTabs,
  onModeChange,
  onNudgeAgentsChange,
  onNudgeUserTabsChange,
}: RestoreSectionProps) {
  return (
    <SettingsSection
      title="Restore terminal tabs"
      infoLabel="About restoring terminal tabs"
      info={(
        <>
          <p>
            Lattice keeps a durable record of every terminal tab. When you open
            this project after a backend restart, a closed browser, a Ctrl+C of
            the dev server, or a reboot, the tabs come back: live sessions are
            re-attached and dead ones are relaunched into their previous
            conversation (Claude <code>--resume</code>, Pi and Codex resume by
            session id).
          </p>
          <p>
            The nudge is a first message telling a relaunched agent to check
            <code>git status</code> and continue. Task and merge-resolver agents
            get it so work picks up unattended. Your own sidebar sessions only
            get it when the option below is on <em>and</em> Lattice finds
            positive evidence the agent was mid-turn when it died — never for a
            session that was waiting on you.
          </p>
        </>
      )}
    >
      <div className="settings-control-row">
        <label className="settings-control-label" htmlFor="restore-terminals-mode">
          On project open
        </label>
        <select
          id="restore-terminals-mode"
          className="settings-select"
          value={mode}
          onChange={(e) => onModeChange(e.target.value as RestoreTerminalsMode)}
        >
          {RESTORE_MODE_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </div>
      <label className="settings-checkbox-row">
        <input
          type="checkbox"
          checked={nudgeAgents}
          onChange={(e) => onNudgeAgentsChange(e.target.checked)}
        />
        <span>Nudge relaunched task and merge-resolver agents to continue</span>
      </label>
      <label className="settings-checkbox-row">
        <input
          type="checkbox"
          checked={nudgeUserTabs}
          onChange={(e) => onNudgeUserTabsChange(e.target.checked)}
        />
        <span>Also nudge my own sidebar sessions when they were interrupted mid-turn</span>
      </label>
    </SettingsSection>
  );
}

// The Terminals tab's project-settings block: the sections above, then one
// checkbox section per `TERMINAL_TOGGLE_SECTIONS` entry, wired to the parent
// draft slice. Composed by `SettingsDialog` ahead of the
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
      <RestoreTerminalsSection
        mode={drafts.restoreTerminalsOnOpen}
        nudgeAgents={drafts.restoreNudgeAgents}
        nudgeUserTabs={drafts.restoreNudgeUserTabs}
        onModeChange={drafts.setRestoreTerminalsOnOpen}
        onNudgeAgentsChange={drafts.setRestoreNudgeAgents}
        onNudgeUserTabsChange={drafts.setRestoreNudgeUserTabs}
      />
      {TERMINAL_TOGGLE_SECTIONS.map((section) => (
        <CheckboxSettingsSection
          key={section.draftKey}
          title={section.title}
          infoLabel={section.infoLabel}
          info={section.info}
          checked={drafts[section.draftKey]}
          onChange={drafts[section.setterKey]}
          label={section.label}
        />
      ))}
    </>
  );
}
