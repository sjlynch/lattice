import type { ReactNode } from 'react';
import type { SettingsDrafts } from './useSettingsDrafts';

// The single-checkbox sections of the Terminals tab's project-settings block,
// as data. `TerminalSettingsSections` renders each entry, in this order, as one
// `CheckboxSettingsSection` wired to the flat `SettingsDrafts` value/setter
// pair it names. Adding one means: an entry here, plus (if the draft is new)
// its value/setter pair on `SettingsDrafts` (and, for a fetched toggle, its key
// + default + read in `fetchedToggles.ts`).

// A boolean draft on `SettingsDrafts` that has a matching `setX` setter (so
// not e.g. the derived `dirty` flag).
type BooleanDraftKey = {
  [K in keyof SettingsDrafts]: SettingsDrafts[K] extends boolean
    ? `set${Capitalize<K & string>}` extends keyof SettingsDrafts
      ? K
      : never
    : never;
}[keyof SettingsDrafts];

// The draft a section reads and the setter it writes — paired, so an entry
// can't read one draft and write another.
type BooleanDraftBinding = {
  [K in BooleanDraftKey]: { draftKey: K; setterKey: `set${Capitalize<K & string>}` };
}[BooleanDraftKey];

export type TerminalToggleSectionSpec = BooleanDraftBinding & {
  title: string;
  infoLabel: string;
  info: ReactNode;
  // The checkbox's label.
  label: string;
};

export const TERMINAL_TOGGLE_SECTIONS: readonly TerminalToggleSectionSpec[] = [
  {
    draftKey: 'codexYolo',
    setterKey: 'setCodexYolo',
    title: 'Codex sandbox and approvals',
    infoLabel: 'About Codex sandbox and approvals',
    info: (
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
    ),
    label: 'Disable Codex sandbox and approval prompts (--yolo)',
  },
  {
    draftKey: 'instrumentClaude',
    setterKey: 'setInstrumentClaude',
    title: 'Show Claude sessions on the graph',
    infoLabel: 'About showing Claude sessions on the graph',
    info: (
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
    ),
    label: 'Instrument Claude sessions in this project',
  },
  {
    draftKey: 'disableMemory',
    setterKey: 'setDisableMemory',
    title: 'Turn off Claude memory for this project',
    infoLabel: 'About turning off Claude memory',
    info: (
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
    ),
    label: 'Disable Claude auto-memory for this project',
  },
  {
    draftKey: 'qaTerminalAutoClose',
    setterKey: 'setQaTerminalAutoClose',
    title: 'QA e2e test terminal',
    infoLabel: 'About the QA e2e test terminal',
    info: (
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
    ),
    label: 'Auto-close the QA e2e terminal when its run finishes',
  },
  {
    draftKey: 'keepWorkflowStepTerminals',
    setterKey: 'setKeepWorkflowStepTerminals',
    title: 'Workflow step terminals',
    infoLabel: 'About workflow step terminals',
    info: (
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
    ),
    label: 'Keep workflow step terminals open after the step finishes',
  },
];
