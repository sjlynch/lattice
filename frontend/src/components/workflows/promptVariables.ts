// Shared helpers for workflow variables on the frontend. Mirrors the backend
// grammar in backend/src/workflows/{normalization,interpolate}.ts so the
// editor's highlighting and name sanitization match what the server stores
// and substitutes at run time.

import type { WorkflowVariable } from '../../api';

export const USER_INSTRUCTIONS_VAR = 'user_instructions';

// `{{` + identifier + `}}`, optional inner whitespace. Global + capturing so
// it can drive both splitting (for highlighting) and replacement.
export const VAR_TOKEN_RE = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g;

// Variable names are referenced as `{{name}}`, so they must reduce to the
// identifier grammar above.
export function normalizeVariableName(value: string): string {
  return value
    .replace(/[^A-Za-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

// Lighter sanitization for live typing in the name input: collapse invalid
// characters to `_` but keep edge underscores so the field doesn't fight the
// user mid-edit. Full normalization happens on save (and on the backend).
export function sanitizeVariableNameInput(value: string): string {
  return value.replace(/[^A-Za-z0-9_]+/g, '_');
}

export function localVariableId(): string {
  return `var_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
}

export function makeVariable(name: string, value = ''): WorkflowVariable {
  return { id: localVariableId(), name, value };
}

// A single empty user_instructions variable — the default every workflow has.
export function defaultVariables(): WorkflowVariable[] {
  return [makeVariable(USER_INSTRUCTIONS_VAR, '')];
}

// Copy a variable's `{{name}}` reference token to the clipboard. Resolves to
// `true` only when the write actually landed: navigator.clipboard.writeText
// rejects on permission denial, a non-secure (http) context, or an unfocused
// document, so callers must await this and gate any "Copied!" feedback on the
// result rather than assuming success. An empty name or absent Clipboard API is
// a no-op that resolves to `false`.
export async function copyVariableToken(
  name: string,
  clipboard: Pick<Clipboard, 'writeText'> | undefined = typeof navigator !==
  'undefined'
    ? navigator.clipboard
    : undefined,
): Promise<boolean> {
  if (!name || !clipboard) return false;
  try {
    await clipboard.writeText(`{{${name}}}`);
    return true;
  } catch {
    return false;
  }
}

// Append the built-in `{{user_instructions}}` injection point to the bottom of
// a built-in prompt (templates / quick-add chips), so every built-in step ends
// with it by default. No-op if the prompt already references it.
export function withUserInstructions(prompt: string): string {
  const token = `{{${USER_INSTRUCTIONS_VAR}}}`;
  if (prompt.includes(token)) return prompt;
  const trimmed = prompt.replace(/\s+$/, '');
  return trimmed ? `${trimmed}\n\n${token}` : token;
}

// Ensure the built-in user_instructions variable is present (and leads).
export function ensureUserInstructions(vars: WorkflowVariable[]): WorkflowVariable[] {
  if (vars.some((v) => v.name === USER_INSTRUCTIONS_VAR)) return vars;
  return [makeVariable(USER_INSTRUCTIONS_VAR, ''), ...vars];
}

// Split a prompt into plain text and variable-reference tokens, for rendering
// a highlight overlay behind the textarea. `known` flags whether a referenced
// variable is actually defined on the workflow.
export type PromptSegment =
  | { text: string; token: false }
  | { text: string; token: true; name: string; known: boolean };

export function splitPromptSegments(
  prompt: string,
  definedNames: ReadonlySet<string>,
): PromptSegment[] {
  const segments: PromptSegment[] = [];
  let lastIndex = 0;
  // Fresh regex state per call (the shared const is stateful with /g).
  VAR_TOKEN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = VAR_TOKEN_RE.exec(prompt)) !== null) {
    if (m.index > lastIndex) {
      segments.push({ text: prompt.slice(lastIndex, m.index), token: false });
    }
    segments.push({
      text: m[0],
      token: true,
      name: m[1],
      known: definedNames.has(m[1]),
    });
    lastIndex = m.index + m[0].length;
  }
  if (lastIndex < prompt.length) {
    segments.push({ text: prompt.slice(lastIndex), token: false });
  }
  return segments;
}
