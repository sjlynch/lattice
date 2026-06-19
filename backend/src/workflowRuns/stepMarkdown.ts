// Renders WORKFLOW_STEP.md — the agent's prompt for a single workflow step.
//
// Includes the helper-script usage docs and the harness-appropriate
// completion instructions: Claude relies on its Stop hook (silent stop), Pi
// relies on its session_shutdown extension *plus* an explicit curl as a
// backstop, codex always curls itself.

import { canonicalProjectPath } from '../projectPath.js';
import { applyTemplate } from '../instructionTemplates/apply.js';
import { DEFAULT_WORKFLOW_STEP_TEMPLATE } from '../instructionTemplates/defs.js';
import {
  interpolateWorkflowVariables,
  type Workflow,
  type WorkflowStepHarness,
} from '../workflows.js';
import type { WorkflowRun } from './state.js';
import {
  renderDirtyStateWarning,
  type DirtyStateSummary,
} from './projectDirtyState.js';

export function effectiveStepHarness(
  wf: Workflow,
  run: WorkflowRun,
  stepIndex: number,
): WorkflowStepHarness {
  return run.harnessOverride ?? wf.steps[stepIndex].harness ?? 'claude';
}

export function renderStepMarkdown(
  wf: Workflow,
  run: WorkflowRun,
  stepIndex: number,
  backendOrigin: string,
  dirtyState: DirtyStateSummary | null = null,
  template: string = DEFAULT_WORKFLOW_STEP_TEMPLATE,
): string {
  const step = wf.steps[stepIndex];
  const harness = effectiveStepHarness(wf, run, stepIndex);
  const canonicalProject = canonicalProjectPath(wf.projectPath);
  const encodedProject = encodeURIComponent(canonicalProject);
  const completeUrl = `${backendOrigin}/api/workflow-runs/${run.id}/steps/${stepIndex}/complete`;
  // Pi/Codex completion instructions intentionally mirror LATTICE_TASK.md's
  // strong autonomy framing: the workflow is sequential and the run will not
  // advance to the next step until /complete fires. Pi gets a brief note that
  // a session_shutdown extension is installed as a backstop — useful so the
  // model knows abnormal exits won't strand the run, but it's not framed as a
  // permission to skip the explicit curl (the backstop is best-effort).
  const completionInstructions = (
    harness === 'claude'
      ? [
          'After creating all the tasks described above, simply stop. Your session',
          'will be finalized automatically and the next workflow step (if any) will',
          'be queued.',
        ]
      : [
          '**Final step — tell Lattice this step is done (do not skip this).**',
          'The workflow will not advance to the next step until this URL is POSTed.',
          'Run this as your *last* action — do not end your turn before it succeeds:',
          '',
          '```bash',
          `curl -s -m 5 -X POST "${completeUrl}?source=model-explicit-curl"`,
          '```',
          ...(harness === 'pi'
            ? [
                '',
                'A `session_shutdown` extension (`.pi/extensions/lattice-complete.ts`)',
                'in this directory will fire the same callback as a backstop if your',
                "session exits without running the curl — but it's best-effort, so",
                'always run the curl yourself.',
              ]
            : []),
        ]
  ).join('\n');
  // Trailing '\n\n' so the preamble sits on its own paragraph above the step
  // prompt; empty for Claude (no preamble).
  const autonomyPreamble =
    harness === 'claude'
      ? ''
      : [
          '> **This is an autonomous workflow-step session — there is no user',
          '> watching to confirm with, and the run will not be picked up again',
          "> if you stop early.** Work through the whole step to completion in",
          '> this same session, without pausing to ask for permission or approval.',
          '> That includes the wrap-up: create the tasks described below and POST',
          "> the `/complete` callback at the very end. Stopping after \"I created",
          "> the tasks\" — without calling `/complete` — leaves the workflow run",
          "> stuck on this step and the next step never spawns. Don't end your",
          "> turn until you've run the curl below.",
        ].join('\n') + '\n\n';
  // If the project tree is dirty, surface the divergence at the very top
  // so the planner reads it before the step prompt. Worktree-mismatch is
  // the single biggest source of "task references a path that doesn't
  // exist" failures; see projectDirtyState.ts.
  const dirtyWarning = dirtyState ? renderDirtyStateWarning(dirtyState) : '';
  // Trailing '\n\n' so the note is its own paragraph; empty when no override.
  const harnessOverrideNote = run.harnessOverride
    ? `Run harness override: every step in this run is using ${run.harnessOverride}.\n\n`
    : '';
  // Substitute `{{var_name}}` references with the workflow's variable values
  // (e.g. the built-in `{{user_instructions}}`) before the prompt reaches the
  // agent. Unknown variables are left intact so a typo is visible, not silent.
  const renderedPrompt = interpolateWorkflowVariables(step.prompt, wf.variables);
  return applyTemplate(template, {
    step_number: String(stepIndex + 1),
    total_steps: String(wf.steps.length),
    step_title: step.title,
    dirty_state_warning: dirtyWarning,
    autonomy_preamble: autonomyPreamble,
    step_prompt: renderedPrompt,
    project_path: canonicalProject,
    project_path_encoded: encodedProject,
    backend_origin: backendOrigin,
    harness_override_note: harnessOverrideNote,
    completion_instructions: completionInstructions,
  });
}
