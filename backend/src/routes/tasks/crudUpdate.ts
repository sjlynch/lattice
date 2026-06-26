// Update / upsert / append-summary handlers — the markdown-ergonomic write
// paths. Single PATCH, bulk update, markdown upsert, and summary append all
// share the "accept JSON or text/markdown body" convention.

import type { Request, Response } from 'express';
import {
  createTask,
  getTask,
  updateTask,
  type Task,
  type TaskStatus,
} from '../../tasks.js';
import { canonicalProjectPath } from '../../projectPath.js';
import type { ParsedTaskBlock } from './markdownBatch.js';
import {
  isValidTaskStatus,
  normalizeBody,
  resolveProject,
  respondJson,
  statusValidationError,
} from './requestUtils.js';
import type { TaskIdRequest, TaskPatch } from './crudTypes.js';

// Assemble the task-patch from a parsed markdown block. Shared by the single
// PATCH markdown path and the upsert loop, which previously open-coded the
// identical title + optional-description + optional-status build. Status is
// cast through here; callers validate it first (PATCH inline, upsert in its
// up-front validation loop) so an invalid value never reaches this.
function blockToPatch(block: ParsedTaskBlock): TaskPatch {
  const patch: TaskPatch = { title: block.title };
  if (block.description !== undefined) patch.description = block.description;
  if (block.status) patch.status = block.status as TaskStatus;
  return patch;
}

// Accepts EITHER a JSON body ({title?, description?, status?}) OR a
// text/markdown / text/plain body. For markdown:
//   - if the body has a `# Heading`, that heading becomes the new title
//     and the body below it becomes the new description.
//   - if it has no heading, the whole body replaces the description and
//     the title is left alone.
// This is the killer ergonomics path for shell agents — heredoc with
// single-quoted EOF replaces multi-line descriptions with zero escaping.
export async function handleTaskUpdate(
  req: TaskIdRequest,
  res: Response,
): Promise<void> {
  const parsed = normalizeBody(req.body);
  let updates: TaskPatch;
  if (parsed.kind === 'markdown') {
    const block = parsed.doc.tasks[0];
    if (block) {
      if (block.status && !isValidTaskStatus(block.status)) {
        res.status(400).json({ error: statusValidationError('status') });
        return;
      }
      updates = blockToPatch(block);
    } else {
      // No heading found — treat the whole body as a description replacement.
      updates = { description: parsed.source.trim() };
    }
  } else {
    updates = parsed.json as TaskPatch;
  }
  await respondJson(res, async () => {
    const updated = await updateTask(req.params.id, updates);
    if (!updated) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    return updated;
  });
}

// Join a new summary onto whatever's already in the task's `summary` field.
// Multiple appends (the worktree agent's change summary, then a QA verdict)
// are stacked newest-last and separated by a horizontal rule so they stay
// visually distinct. Pure + exported so it can be unit-tested in isolation.
export function appendSummaryText(existing: string | undefined, addition: string): string {
  const prev = existing?.trim() || '';
  const next = addition.trim();
  return prev ? `${prev}\n\n---\n\n${next}` : next;
}

// Accepts EITHER a JSON body ({summary}) OR a text/markdown / text/plain
// body whose whole content becomes the summary. Markdown body lets agents
// pipe long heredoc summaries through curl without any JSON escaping.
//
// The summary is appended to the task's dedicated `summary` field — NOT the
// `description`. The original ticket text the human wrote stays pristine; the
// board renders the resolution/update text alongside it (see the 2026-06-19
// "stop replacing the description" change).
export async function handleTaskAppendSummary(
  req: TaskIdRequest,
  res: Response,
): Promise<void> {
  const parsed = normalizeBody(req.body);
  const summary =
    parsed.kind === 'markdown'
      ? parsed.source
      : (parsed.json as { summary?: string }).summary;
  if (!summary?.trim()) {
    res.status(400).json({ error: 'summary required' });
    return;
  }
  await respondJson(res, async () => {
    const task = await getTask(req.params.id);
    if (!task) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    const appended = appendSummaryText(task.summary, summary);
    const updated = await updateTask(req.params.id, { summary: appended });
    if (!updated) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    return updated;
  });
}

// Bulk update — one round trip for N {id, …} patches. Saves agents from
// the N-PATCH loop when they're refining a backlog. Each update is
// independent; missing IDs are reported in the response but do not fail
// the batch. Like single PATCH, idempotent on no-op updates.
type BulkUpdateRequest = Request<unknown, unknown, {
  updates?: Array<{ id?: string } & TaskPatch>;
}>;

export async function handleTaskBulkUpdate(
  req: BulkUpdateRequest,
  res: Response,
): Promise<void> {
  const body = (req.body ?? {}) as {
    updates?: Array<{ id?: string } & TaskPatch>;
  };
  const updates = body.updates;
  if (!Array.isArray(updates) || updates.length === 0) {
    res.status(400).json({ error: 'updates must be a non-empty array' });
    return;
  }
  for (let i = 0; i < updates.length; i++) {
    const u = updates[i];
    if (!u || typeof u.id !== 'string' || !u.id.trim()) {
      res.status(400).json({ error: `updates[${i}].id is required` });
      return;
    }
    if (u.status !== undefined && !isValidTaskStatus(u.status)) {
      res.status(400).json({ error: `updates[${i}].${statusValidationError('status')}` });
      return;
    }
  }
  await respondJson(res, async () => {
    const results = await Promise.all(
      updates.map(({ id, ...patch }) => updateTask(id!, patch)),
    );
    const updated: Task[] = [];
    const missing: string[] = [];
    results.forEach((r, i) => {
      if (r) updated.push(r);
      else missing.push(updates[i].id!);
    });
    return { updated: updated.length, missing, tasks: updated };
  });
}

// Decide how an id-bearing upsert block must be treated relative to the
// upsert's resolved project. `updateTask` resolves a task id across EVERY known
// project, so without this an upsert scoped to project B could mutate project
// A's task just because the pasted markdown carried A's `{id=...}` (a
// round-trip doc from another project, or a stale agent scratch file) —
// cross-project data corruption while the caller thinks they're editing B.
//   - no such id anywhere        → 'missing'
//   - id exists, another project → 'foreign'  (never updated; reported distinctly)
//   - id exists in this project  → 'update'
export function classifyUpsertTarget(
  existing: Pick<Task, 'projectPath'> | null | undefined,
  canonicalProject: string,
): 'update' | 'foreign' | 'missing' {
  if (!existing) return 'missing';
  return canonicalProjectPath(existing.projectPath) === canonicalProject
    ? 'update'
    : 'foreign';
}

// Upsert from markdown — the "backlog as a document" workflow. Accepts the
// same markdown grammar as GET ?format=markdown, so a "GET → edit → POST"
// round trip works with zero JSON. Headings with `{id=...}` update existing
// tasks; headings without an id create new tasks. Status is preserved when
// omitted (keeps existing); set it explicitly via `{id=..., status=...}`.
//
// Additive by default — tasks NOT in the document are left alone. There is
// no prune option on purpose: silent deletion has bitten this codebase
// before. To delete tasks, use DELETE /api/tasks/:id explicitly.
export async function handleTaskUpsert(
  req: Request,
  res: Response,
): Promise<void> {
  const project = resolveProject(req);
  if (!project) {
    res.status(400).json({ error: 'project required (query string or JSON body)' });
    return;
  }
  const parsed = normalizeBody(req.body);
  const blocks: ParsedTaskBlock[] =
    parsed.kind === 'markdown'
      ? parsed.doc.tasks
      : Array.isArray(parsed.json.tasks)
        ? (parsed.json.tasks as ParsedTaskBlock[])
        : [];
  if (blocks.length === 0) {
    res.status(400).json({
      error: 'no tasks parsed — markdown body needs `# Heading` lines, or JSON body needs {tasks:[...]}',
    });
    return;
  }
  // Validate up front so a single bad heading fails fast instead of leaving
  // a partial upsert in place.
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (!b.title || !b.title.trim()) {
      res.status(400).json({ error: `tasks[${i}].title is required` });
      return;
    }
    if (b.status !== undefined && !isValidTaskStatus(b.status)) {
      res.status(400).json({ error: `tasks[${i}].${statusValidationError('status')}` });
      return;
    }
  }
  const canonicalProject = canonicalProjectPath(project);
  await respondJson(res, async () => {
    const created: Task[] = [];
    const updated: Task[] = [];
    const missing: string[] = [];
    const foreign: string[] = [];
    for (const b of blocks) {
      if (b.id) {
        // Project-scoping guard: only update a task that already belongs to
        // THIS project. updateTask resolves ids across every project, so an
        // unguarded update of a foreign id would silently mutate another
        // project's task. Report missing/foreign distinctly; never update.
        const existing = await getTask(b.id);
        const target = classifyUpsertTarget(existing, canonicalProject);
        if (target === 'missing') {
          missing.push(b.id);
          continue;
        }
        if (target === 'foreign') {
          foreign.push(b.id);
          continue;
        }
        const result = await updateTask(b.id, blockToPatch(b));
        if (result) updated.push(result);
        else missing.push(b.id);
      } else {
        const task = await createTask(project, b.title, b.description);
        if (b.status && b.status !== task.status) {
          const withStatus = await updateTask(task.id, { status: b.status as TaskStatus });
          created.push(withStatus ?? task);
        } else {
          created.push(task);
        }
      }
    }
    return {
      created: created.length,
      updated: updated.length,
      missing,
      foreign,
      tasks: { created, updated },
    };
  });
}
