// The workflow `{{variable}}` grammar, shared by the backend interpolator
// (`workflows/interpolate.ts`, `workflows/normalization.ts`) and the frontend
// editor (`components/workflows/promptVariables.ts`), so the editor never
// highlights a token the server won't substitute.

// The built-in variable every workflow carries; built-in step prompts end with
// `{{user_instructions}}`.
export const USER_INSTRUCTIONS_VAR = 'user_instructions';

// `{{` + identifier + `}}`, optional inner whitespace. Global + capturing: a
// caller that `exec`s it in a loop must reset `lastIndex` first.
export const WORKFLOW_VARIABLE_PATTERN = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g;

// A variable name reduced to that identifier grammar ('' for a non-string).
export function normalizeVariableName(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value
    .trim()
    .replace(/[^A-Za-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '');
}
