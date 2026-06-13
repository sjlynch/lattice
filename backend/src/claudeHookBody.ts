// Shared parsing for Claude PreToolUse/PostToolUse hook payloads (delivered
// to our activity endpoints as the POST body). Used by both the task-worktree
// activity route and the non-worktree agent-activity route.

export type ClaudeHookPhase = 'start' | 'end';

// Read/Edit/Write/MultiEdit use `tool_input.file_path`; NotebookEdit uses
// `notebook_path`. Returns the raw path string (absolute or cwd-relative) or
// null when the payload doesn't name one file.
export function fileFromHookBody(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const input = (body as Record<string, unknown>).tool_input;
  if (!input || typeof input !== 'object') return null;
  const i = input as Record<string, unknown>;
  const f = i.file_path ?? i.notebook_path;
  return typeof f === 'string' && f ? f : null;
}

export function phaseFromHookBody(body: unknown): ClaudeHookPhase {
  const name =
    body && typeof body === 'object'
      ? (body as Record<string, unknown>).hook_event_name
      : undefined;
  return name === 'PostToolUse' ? 'end' : 'start';
}

export function toolFromHookBody(body: unknown): string {
  const t =
    body && typeof body === 'object'
      ? (body as Record<string, unknown>).tool_name
      : undefined;
  return typeof t === 'string' ? t : 'unknown';
}

// The agent's working directory at hook time. Relative `file_path`s resolve
// against this.
export function cwdFromHookBody(body: unknown): string | null {
  const c =
    body && typeof body === 'object'
      ? (body as Record<string, unknown>).cwd
      : undefined;
  return typeof c === 'string' && c ? c : null;
}
