import path from 'node:path';
import type { Response } from 'express';
import type { TaskStatus } from '../../tasks.js';
import { parseMarkdownDoc, type ParsedMarkdownDoc } from './markdownBatch.js';

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

// Read endpoints (list / summary) intentionally do NOT require the project
// directory to exist — listing a deleted project's tasks is a feature of
// home-scoped storage. But a NON-absolute project is always shell-escaping
// damage: canonicalProjectPath's path.resolve() would invent a bogus absolute
// path rooted at the backend's cwd. Reject it loudly (400) so the caller sees
// the mangling instead of a silently-empty result. Only call this once the
// project is known non-empty (an omitted project has its own "required" 400).
// Returns true when it's safe to proceed; otherwise it has already sent the 400.
export function requireAbsoluteProject(project: string, res: Response): boolean {
  if (path.isAbsolute(project)) return true;
  res.status(400).json({
    error:
      `project must be an absolute path, got ${JSON.stringify(project)}. ` +
      `A relative or drive-relative path almost always means backslashes were ` +
      `stripped by shell escaping (e.g. C:\\development\\proj arriving as ` +
      `"C:developmentproj"). Pass the full absolute path.`,
  });
  return false;
}

export function isValidTaskStatus(status: unknown): status is TaskStatus {
  return typeof status === 'string' && VALID_STATUS_SET.has(status);
}

export function statusValidationError(field: 'status' | 'fromStatus'): string {
  return `${field} must be one of: ${VALID_STATUSES.join(', ')}`;
}

// The "JSON body OR text/markdown / text/plain body" convention shared by the
// task write handlers (PATCH /api/tasks/:id, /append-summary, /upsert). The
// `textOrMarkdownBody` parser in crud.ts hands us a string for a markdown /
// plain-text body and a parsed object for JSON. Classify (and parse the
// markdown) once here so each handler reads a single discriminated shape rather
// than re-deriving `typeof req.body === 'string'` — and re-calling
// parseMarkdownDoc — inline. Each handler picks what it needs off the result:
// /update reads `doc.tasks[0]` (or falls back to the raw `source`),
// /append-summary takes the raw `source`, /upsert reads all of `doc.tasks`.
export type NormalizedBody =
  | { kind: 'markdown'; source: string; doc: ParsedMarkdownDoc }
  | { kind: 'json'; json: Record<string, unknown> };

export function normalizeBody(body: unknown): NormalizedBody {
  if (typeof body === 'string') {
    return { kind: 'markdown', source: body, doc: parseMarkdownDoc(body) };
  }
  return { kind: 'json', json: (body ?? {}) as Record<string, unknown> };
}
