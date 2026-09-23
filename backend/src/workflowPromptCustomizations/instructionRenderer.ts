import type { WorkflowPromptCustomization } from './types.js';

export function renderCustomizationInstructions(
  request: WorkflowPromptCustomization,
): string {
  const templateLine = request.templateId
    ? `Template type: ${request.templateTitle ?? request.templateId}`
    : 'Template type: custom user-authored workflow step';
  const customInstructions = request.customInstructions?.trim();
  // Non-Claude harnesses get the same strong autonomy preamble as
  // LATTICE_TASK.md / WORKFLOW_STEP.md: this is an unwatched session, the
  // turn won't be picked up again, run the submit script as the final
  // action. Claude relies on its Stop hook (which now invokes the
  // backstop script — see backstopScripts.ts) so its preamble stays light.
  const autonomyPreamble =
    request.harness === 'claude'
      ? ''
      : [
          '> **This is an autonomous prompt-customization session — no user is',
          "> watching to confirm with, and the turn won't be picked up again.**",
          '> Inspect the project, write `CUSTOMIZED_PROMPT.md`, and run the',
          '> submit script as your final action. The UI is blocked on this',
          '> callback — stopping after "I wrote the file" without submitting',
          '> leaves the customization stuck in "running" forever.',
          '',
        ].join('\n');
  const backstopNote =
    request.harness === 'claude'
      ? [
          '> Backstop: a Stop hook in `.claude/settings.local.json` will invoke',
          '> the backstop script automatically when your session exits — but',
          '> still run the submit script yourself so the callback fires while',
          '> the user is watching the UI rather than at session-exit time.',
        ].join('\n')
      : request.harness === 'pi'
      ? [
          '> Backstop: a `session_shutdown` extension in',
          '> `.pi/extensions/lattice-complete.ts` will read',
          '> `CUSTOMIZED_PROMPT.md` and POST it for you if your session exits',
          '> without running the submit script — best-effort only, so always',
          '> run the submit script as your final action.',
        ].join('\n')
      : [
          '> No automatic backstop is installed for this harness — you MUST',
          '> run the submit script yourself or the customization will hang',
          '> in "running" forever.',
        ].join('\n');
  return [
    `# Customize workflow prompt: ${request.stepTitle || 'Untitled step'}`,
    '',
    autonomyPreamble,
    'You are customizing a Lattice workflow step prompt for the active project.',
    'Do not edit project files, do not create tasks, and do not commit anything.',
    '',
    '## Active project',
    '',
    `Project root: \`${request.projectPath}\``,
    `Selected harness for the step: ${request.harness}`,
    templateLine,
    '',
    'Inspect the project as needed, then rewrite the workflow step prompt so it is tailored to this project while preserving the original intent.',
    request.templateId
      ? 'Adhere to the template type above. Keep the prompt self-contained and suitable for future agents that will create Lattice tasks from it.'
      : 'Use the user customization instructions below as the source of truth for how this custom prompt should be tailored.',
    'The final prompt should be actionable, concise enough to live in the workflow editor, and specific about languages/frameworks/tests/docs that matter in this project.',
    "Do not carry the project's \"run the tests / type-check before committing\" rules (from CLAUDE.md, AGENTS.md or similar docs) into the prompt or into the tasks it asks for: task agents are told not to run tests, and a separate Run tests workflow step verifies merged work.",
    '',
    ...(customInstructions
      ? [
          '## User customization instructions',
          '',
          customInstructions,
          '',
        ]
      : []),
    '## Current workflow prompt',
    '',
    '```markdown',
    request.originalPrompt,
    '```',
    '',
    '## Return the customized prompt',
    '',
    '1. Write only the revised workflow prompt body to `CUSTOMIZED_PROMPT.md` in this directory.',
    '2. Submit it back to Lattice with:',
    '',
    '```bash',
    'node submit-customized-prompt.cjs CUSTOMIZED_PROMPT.md',
    '```',
    '',
    'After the callback succeeds, stop. The browser will update the workflow step automatically.',
    '',
    backstopNote,
  ].join('\n');
}
