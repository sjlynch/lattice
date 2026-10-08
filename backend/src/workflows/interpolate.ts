// Variable interpolation for workflow step prompts.
//
// Wherever a step prompt contains `{{var_name}}`, the workflow's matching
// variable value is substituted in before the prompt is handed to an agent
// (see workflowRuns/stepMarkdown.ts). Unknown variables are left untouched so
// an accidental `{{typo}}` is visible in the rendered prompt rather than
// silently vanishing.

import type { WorkflowVariable } from './types.js';
import { WORKFLOW_VARIABLE_PATTERN } from '../shared/workflowVariables.js';

// The `{{name}}` grammar is shared with the frontend editor.
export { WORKFLOW_VARIABLE_PATTERN };

export function interpolateWorkflowVariables(
  prompt: string,
  variables: WorkflowVariable[] | undefined,
): string {
  if (!prompt || !variables || variables.length === 0) return prompt;
  const byName = new Map<string, string>();
  for (const v of variables) {
    if (v && typeof v.name === 'string') {
      byName.set(v.name, typeof v.value === 'string' ? v.value : '');
    }
  }
  return prompt.replace(WORKFLOW_VARIABLE_PATTERN, (match, name: string) =>
    byName.has(name) ? byName.get(name)! : match,
  );
}
