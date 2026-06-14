// Variable interpolation for workflow step prompts.
//
// Wherever a step prompt contains `{{var_name}}`, the workflow's matching
// variable value is substituted in before the prompt is handed to an agent
// (see workflowRuns/stepMarkdown.ts). Unknown variables are left untouched so
// an accidental `{{typo}}` is visible in the rendered prompt rather than
// silently vanishing.

import type { WorkflowVariable } from './types.js';

// Same grammar as normalizeVariableName: `{{` + identifier + `}}`, with
// optional surrounding whitespace inside the braces.
export const WORKFLOW_VARIABLE_PATTERN = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g;

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
