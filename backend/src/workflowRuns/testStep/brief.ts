// Renders RUN_TESTS.md — the Run tests step's brief — from the `run-tests`
// instruction template (instructionTemplates/templates/runTests.ts). Pure and
// synchronous like every other renderer; the spawn path resolves the project's
// template override and computes the dynamic blocks first.

import path from 'node:path';
import { applyTemplate } from '../../instructionTemplates/apply.js';
import { DEFAULT_RUN_TESTS_TEMPLATE } from '../../instructionTemplates/defs.js';
import type { WorkflowStepHarness } from '../../workflows.js';
import { renderStepCompletionInstructions } from '../stepMarkdown.js';

export const TEST_SUMMARY_FILENAME = 'TEST_SUMMARY.md';

export type RunTestsBriefInput = {
  harness: WorkflowStepHarness;
  projectPath: string;
  stepDir: string;
  stepIndex: number;
  totalSteps: number;
  completeUrl: string;
  timeoutMinutes: number;
  userWipFile: string;
  userWipCount: number | null;
  recentTasksBlock: string;
};

export function renderRunTestsBrief(
  input: RunTestsBriefInput,
  template: string = DEFAULT_RUN_TESTS_TEMPLATE,
): string {
  const summaryFile = path.join(input.stepDir, TEST_SUMMARY_FILENAME);
  const completion = renderStepCompletionInstructions(input.harness, input.completeUrl, [
    `When \`${TEST_SUMMARY_FILENAME}\` is written, simply stop. Your session will be`,
    'finalized automatically and the next workflow step (if any) will be',
    'queued.',
  ]);
  // Pi/Codex have no user watching either; same framing as the other
  // workflow-step briefs. Trailing '\n\n' so it is its own paragraph.
  const autonomyPreamble =
    input.harness === 'claude'
      ? ''
      : [
          '> **This is an autonomous workflow-step session — there is no user',
          '> watching to confirm with.** Work through the whole step in this same',
          '> session without pausing for approval: run the tests, fix what you can,',
          '> commit, write the report, then POST the `/complete` callback at the very',
          "> end. Until that callback lands the workflow stays on this step.",
        ].join('\n') + '\n\n';
  const wipSummary =
    input.userWipCount === null
      ? 'Lattice could not read `git status` when the step started, so the list may be empty — run `git status` yourself and treat every change you did not make as the user\'s'
      : input.userWipCount === 0
        ? 'none — the checkout was clean'
        : `${input.userWipCount} path(s)`;
  return applyTemplate(template, {
    step_number: String(input.stepIndex + 1),
    total_steps: String(input.totalSteps),
    autonomy_preamble: autonomyPreamble,
    project_path: input.projectPath,
    step_dir: input.stepDir,
    timeout_minutes: String(input.timeoutMinutes),
    recent_tasks: input.recentTasksBlock,
    user_wip_file: input.userWipFile,
    user_wip_summary: wipSummary,
    test_summary_file: summaryFile,
    completion_instructions: completion,
  });
}
