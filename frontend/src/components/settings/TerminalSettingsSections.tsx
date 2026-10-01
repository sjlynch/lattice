import { type RestoreTerminalsMode, type TerminalDefaultHarness } from '../../api';
import { CheckboxSettingsSection, SettingsSection } from './SettingsSection';
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

type CodexYoloSectionProps = {
  enabled: boolean;
  onChange: (value: boolean) => void;
};

function CodexYoloSection({ enabled, onChange }: CodexYoloSectionProps) {
  return (
    <CheckboxSettingsSection
      title="Codex sandbox and approvals"
      infoLabel="About Codex sandbox and approvals"
      info={(
        <>
          <p>
            Launches every Codex session Lattice spawns — task runs, workflow
            steps, the post-merge hook, prompt customization, and new Codex
            terminals — with <code>--yolo</code>, Codex’s analogue of Claude’s{' '}
            <code>--dangerously-skip-permissions</code>: it disables Codex's
            sandbox and runs tool calls without pausing for approval.
          </p>
          <p>
            On by default. Turn it off to launch Codex with the sandbox and
            approval policy from your Codex configuration. Changes apply to new
            sessions; running sessions keep their launch settings.
          </p>
        </>
      )}
      checked={enabled}
      onChange={onChange}
      label="Disable Codex sandbox and approval prompts (--yolo)"
    />
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
    <CheckboxSettingsSection
      title="Show Claude sessions on the graph"
      infoLabel="About showing Claude sessions on the graph"
      info={(
        <>
          <p>
            Adds activity hooks to this project’s{' '}
            <code>.claude/settings.local.json</code> so any Claude session working
            in this project — even ones you launch yourself in a terminal —
            appears as an orange node with focus beams.
          </p>
          <p>
            Your own Claude config is preserved; turning this off removes
            Lattice’s hooks. Sessions must be (re)started to pick up the change.
          </p>
        </>
      )}
      checked={enabled}
      onChange={onChange}
      label="Instrument Claude sessions in this project"
    />
  );
}

type ClaudeMemorySectionProps = {
  disabled: boolean;
  onChange: (value: boolean) => void;
};

function ClaudeMemorySection({ disabled, onChange }: ClaudeMemorySectionProps) {
  return (
    <CheckboxSettingsSection
      title="Turn off Claude memory for this project"
      infoLabel="About turning off Claude memory"
      info={(
        <>
          <p>
            Disables Claude Code’s auto-memory for this project — both the agents
            Lattice runs in worktrees and any Claude session you start yourself in
            the project tree. Recommended when running many agents in parallel,
            since they would otherwise share and thrash one project memory store.
          </p>
          <p>
            Written per-project (the project’s{' '}
            <code>.claude/settings.local.json</code> plus an env var on spawned
            agents); your machine-global Claude memory in other projects is left
            untouched.
          </p>
        </>
      )}
      checked={disabled}
      onChange={onChange}
      label="Disable Claude auto-memory for this project"
    />
  );
}

type QaTerminalSectionProps = {
  autoClose: boolean;
  onChange: (value: boolean) => void;
};

function QaTerminalSection({ autoClose, onChange }: QaTerminalSectionProps) {
  return (
    <CheckboxSettingsSection
      title="QA e2e test terminal"
      infoLabel="About the QA e2e test terminal"
      info={(
        <>
          <p>
            When a QA-lane end-to-end (Playwright) test finishes, its terminal
            stays open by default so you can read the PASS/FAIL verdict and
            output. Enable this to auto-close it the moment the run completes.
          </p>
          <p>
            The task’s qa&nbsp;→&nbsp;done auto-advance is unaffected either way.
          </p>
        </>
      )}
      checked={autoClose}
      onChange={onChange}
      label="Auto-close the QA e2e terminal when its run finishes"
    />
  );
}

type WorkflowStepTerminalSectionProps = {
  keepOpen: boolean;
  onChange: (value: boolean) => void;
};

function WorkflowStepTerminalSection({ keepOpen, onChange }: WorkflowStepTerminalSectionProps) {
  return (
    <CheckboxSettingsSection
      title="Workflow step terminals"
      infoLabel="About workflow step terminals"
      info={(
        <>
          <p>
            By default a workflow agent step’s terminal (<code>wf:step1</code>, …)
            closes as soon as the step finishes and the run moves on. Enable
            this to keep it open with the agent’s full session, e.g. to see why
            a step didn’t file the tasks you expected.
          </p>
          <p>
            A kept tab is an idle agent session: it still counts toward the
            concurrent-agent limit until you close the tab. The workflow
            advances the same way either way.
          </p>
        </>
      )}
      checked={keepOpen}
      onChange={onChange}
      label="Keep workflow step terminals open after the step finishes"
    />
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

// The Terminals tab's project-settings block: the sections above, wired to
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
      <RestoreTerminalsSection
        mode={drafts.restoreTerminalsOnOpen}
        nudgeAgents={drafts.restoreNudgeAgents}
        nudgeUserTabs={drafts.restoreNudgeUserTabs}
        onModeChange={drafts.setRestoreTerminalsOnOpen}
        onNudgeAgentsChange={drafts.setRestoreNudgeAgents}
        onNudgeUserTabsChange={drafts.setRestoreNudgeUserTabs}
      />
      <CodexYoloSection enabled={drafts.codexYolo} onChange={drafts.setCodexYolo} />
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
      <WorkflowStepTerminalSection
        keepOpen={drafts.keepWorkflowStepTerminals}
        onChange={drafts.setKeepWorkflowStepTerminals}
      />
    </>
  );
}
