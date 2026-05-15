import type { WorkflowPromptCustomization } from './types.js';

export function renderCustomizationInstructions(
  request: WorkflowPromptCustomization,
): string {
  const templateLine = request.templateId
    ? `Template type: ${request.templateTitle ?? request.templateId}`
    : 'Template type: custom user-authored workflow step';
  const customInstructions = request.customInstructions?.trim();
  return [
    `# Customize workflow prompt: ${request.stepTitle || 'Untitled step'}`,
    '',
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
  ].join('\n');
}
