import path from 'node:path';
import type { Response } from 'express';
import { getTask, type Task, type TaskStatus } from '../../tasks.js';
import { canonicalProjectPath } from '../../projectPath.js';
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

// Optional project pinning for the by-id routes (`GET/PATCH/DELETE /api/tasks/
// :id`, `/append-summary`, `/run`, `/resume`, `/merge`, `/cancel-queued-run`).
// `getTask(id)` is a GLOBAL lookup across every indexed project, so an id alone
// reaches any board on the machine. When the caller sends `?project=` — the
// `lattice` MCP server does on every call, and the generated docs' recipes do
// too — the task must belong to it, else a 404: an id copied from another
// board's doc, or hallucinated, can neither read nor mutate a foreign task. The
// 404 carries a hint (this is a single-user local tool; "wrong board" is more
// useful to the agent than a poker face). Callers that send no project — the
// worktree Stop-hook callbacks, the board UI — are exactly as before.
// Returns true when the request may proceed; false once it has sent the 404.
export function requireTaskInRequestedProject(
  task: Pick<Task, 'id' | 'projectPath'>,
  req: { query: unknown },
  res: Response,
): boolean {
  const q = req.query as Record<string, unknown> | undefined;
  const project = typeof q?.project === 'string' ? q.project.trim() : '';
  if (!project) return true;
  if (canonicalProjectPath(task.projectPath) === canonicalProjectPath(project)) return true;
  res.status(404).json({
    error: 'not found',
    hint:
      `task ${task.id} is not in project ${canonicalProjectPath(project)} — it belongs ` +
      'to a different board. Check the project this session is pinned to before retrying.',
  });
  return false;
}

// The same `?project=` pin for the bulk by-id write routes (`/transition` with
// explicit `ids`, `/bulk-update`), mirroring what `/upsert` does per block:
// `updateTask(id)` is a global lookup, so without this the `lattice` MCP
// `transition_tasks` tool (which always sends `project=`) could re-lane or
// "delete" another board's task. Ids that belong to a different project land in
// `foreign` (reported, never written); everything else — including ids that
// exist nowhere, which the write path still reports as `missing` — stays in
// `own`. With no project sent, every id is `own`, exactly as before.
export async function partitionIdsByRequestedProject(
  ids: string[],
  req: { query: unknown },
): Promise<{ own: string[]; foreign: string[] }> {
  const q = req.query as Record<string, unknown> | undefined;
  const project = typeof q?.project === 'string' ? q.project.trim() : '';
  if (!project) return { own: ids, foreign: [] };
  const canonical = canonicalProjectPath(project);
  const existing = await Promise.all(ids.map((id) => getTask(id)));
  const own: string[] = [];
  const foreign: string[] = [];
  existing.forEach((task, i) => {
    if (task && canonicalProjectPath(task.projectPath) !== canonical) foreign.push(ids[i]);
    else own.push(ids[i]);
  });
  return { own, foreign };
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
