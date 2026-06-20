import type { Response } from 'express';
import type { TaskStatus } from '../../tasks.js';

// Shared happy-path wrapper for the tasks CRUD handlers. `fn` runs the
// handler body and either returns the success payload (sent as JSON) or
// responds itself (e.g. a 404 not-found, or a markdown `res.send`) — in
// which case `res.headersSent` short-circuits the JSON send. Any throw is
// turned into `{ error: message }` at `statusForError` (default 500),
// standardizing the generic catch that every handler used to open-code.
//
// Validation that runs BEFORE the call (400s, early 404s) stays in the
// handler, before invoking this — only the generic error path is shared.
export async function respondJson(
  res: Response,
  fn: () => unknown | Promise<unknown>,
  statusForError = 500,
): Promise<void> {
  try {
    const body = await fn();
    if (!res.headersSent) res.json(body);
  } catch (err) {
    if (!res.headersSent) {
      res.status(statusForError).json({ error: (err as Error).message });
    }
  }
}

export const VALID_STATUSES = [
  'backlog',
  'open',
  'in_progress',
  'ready_to_merge',
  'qa',
  'done',
  'deleted',
] as const satisfies readonly TaskStatus[];

const VALID_STATUS_SET = new Set<string>(VALID_STATUSES);

// Resolve `project` from query string first (preferred — keeps the body
// pure data) then fall back to the body. Lets shell agents put project
// in the URL where it's easy to URL-encode and stop wrestling JSON for
// it on every call.
export function resolveProject(req: { query: unknown; body: unknown }): string {
  const q = req.query as Record<string, unknown> | null;
  const b = req.body as Record<string, unknown> | string | null;
  if (q && typeof q.project === 'string' && q.project) return q.project;
  if (b && typeof b === 'object' && typeof (b as Record<string, unknown>).project === 'string') {
    return (b as Record<string, string>).project;
  }
  return '';
}

export function isValidTaskStatus(status: unknown): status is TaskStatus {
  return typeof status === 'string' && VALID_STATUS_SET.has(status);
}

export function statusValidationError(field: 'status' | 'fromStatus'): string {
  return `${field} must be one of: ${VALID_STATUSES.join(', ')}`;
}
