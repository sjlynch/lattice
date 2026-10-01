// Renders WORKFLOW_STEP.md — the agent's prompt for a single workflow step.
//
// Includes the helper-script usage docs and the harness-appropriate
// completion instructions: Claude relies on its Stop hook (silent stop), Pi
// relies on its session_shutdown extension *plus* an explicit curl as a
// backstop, codex always curls itself.

import path from 'node:path';
import { canonicalProjectPath } from '../projectPath.js';
import { LATTICE_API_DOC_FILENAME } from '../latticeApiDocs.js';
import { applyTemplate } from '../instructionTemplates/apply.js';
import { DEFAULT_WORKFLOW_STEP_TEMPLATE } from '../instructionTemplates/defs.js';
import {
  interpolateWorkflowVariables,
  type Workflow,
  type WorkflowStepHarness,
} from '../workflows.js';
import type { WorkflowRun } from './state.js';
import { activeStepIndices } from './execution.js';
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

// The Pi model for a step, mirroring effectiveStepHarness: a run-level override
// (its piModelOverride) wins when set, otherwise the step's own piModel. Only
// meaningful when the effective harness is `pi`; returns undefined otherwise so
// the command builder falls back to Pi's default.
export function effectiveStepPiModel(
  wf: Workflow,
  run: WorkflowRun,
  stepIndex: number,
): string | undefined {
  if (effectiveStepHarness(wf, run, stepIndex) !== 'pi') return undefined;
  return run.harnessOverride ? run.piModelOverride : wf.steps[stepIndex].piModel;
}

// The `{{completion_instructions}}` block of a workflow-step brief. Claude is
// told to simply stop (`claudeLines` — its silent Stop hook reports
// completion); Pi/Codex are told to POST the step's /complete URL as their
// last action, with Pi's `session_shutdown` extension named as the backstop.
// Shared by WORKFLOW_STEP.md and the Run tests brief (testStep/brief.ts) so
// the two can't drift.
export function renderStepCompletionInstructions(
  harness: WorkflowStepHarness,
  completeUrl: string,
  claudeLines: string[],
): string {
  return (
    harness === 'claude'
      ? claudeLines
      : [
          '**Final step — tell Lattice this step is done (do not skip this).**',
          'The workflow will not advance to the next step until this URL is POSTed.',
          'Run this as your *last* action — do not end your turn before it succeeds:',
          '',
          '```bash',
          `curl -s -m 20 --retry 15 --retry-delay 3 --retry-connrefused -X POST "${completeUrl}?source=model-explicit-curl"`,
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
}

export function renderStepMarkdown(
  wf: Workflow,
  run: WorkflowRun,
  stepIndex: number,
  backendOrigin: string,
  dirtyState: DirtyStateSummary | null = null,
  template: string = DEFAULT_WORKFLOW_STEP_TEMPLATE,
  // The rendered `{{tool_reports}}` block from stepTools.ts ('' = no tools).
  toolReports: string = '',
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
  //
  // Claude's line is deliberately NOT phrased as "after creating all the tasks
  // described above" any more: a step prompt that doesn't literally enumerate
  // tasks made that read as unfilled boilerplate, which is what let a planner
  // talk itself into implementing + committing the step instead (2026-08).
  const completionInstructions = renderStepCompletionInstructions(harness, completeUrl, [
    "When this step's work is done — the tasks are filed, or you have",
    'concluded that none are needed — simply stop. Your session will be',
    'finalized automatically and the next workflow step (if any) will be',
    'queued.',
  ]);
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
          '> That includes the wrap-up: file the tasks this step calls for and POST',
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
  const markdown = applyTemplate(template, {
    step_number: String(stepIndex + 1),
    total_steps: String(wf.steps.length),
    step_title: step.title,
    dirty_state_warning: dirtyWarning,
    autonomy_preamble: autonomyPreamble,
    step_prompt: renderedPrompt,
    // Trailing '\n\n' so the block sits as its own section under the prompt;
    // empty when the step has no pre-run tools.
    tool_reports: toolReports ? `${toolReports.replace(/\n+$/, '')}\n\n` : '',
    project_path: canonicalProject,
    project_path_encoded: encodedProject,
    // The auto-managed full API cheatsheet. `ensureLatticeApiDoc` writes it at
    // pty spawn (which happens after this render) whenever `<project>/.lattice/`
    // exists — and it always does here, since the step's own scratch dir lives
    // under it. Path only; the file itself is owned by latticeApiDocs.ts.
    lattice_api_doc_path: path.join(canonicalProject, '.lattice', LATTICE_API_DOC_FILENAME),
    backend_origin: backendOrigin,
    harness_override_note: harnessOverrideNote,
    completion_instructions: completionInstructions,
  });
  return activeStepIndices(run).length > 1
    ? '> **Parallel review group:** other reviews are running alongside this step. File independent tasks, leave their tickets intact, and do not wait for their output. Lattice waits for the whole group before continuing.\n\n' + markdown
    : markdown;
}
