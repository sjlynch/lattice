import type { TaskStatus } from '../../tasks.js';

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
