// Update / upsert / append-summary handlers — the markdown-ergonomic write
// paths. Single PATCH, bulk update, markdown upsert, and summary append all
// share the "accept JSON or text/markdown body" convention.

import type { Request, Response } from 'express';
import { appendTaskSummary, getTask, updateTask, type Task } from '../../tasks.js';
import { appendSummaryText } from '../../taskCache/taskUpdate.js';
import {
  partitionIdsByRequestedProject,
  requireTaskInRequestedProject,
  resolveProject,
  respondJson,
} from './requestUtils.js';
import { validateProjectForCreate } from './projectValidation.js';
import type { TaskIdRequest } from './crudTypes.js';
import {
  summaryFromBody,
  taskPatchFromBody,
  upsertBlocksFromBody,
} from './crudUpdateBody.js';
import {
  bulkUpdatesFromBody,
  validateUpsertBlocks,
  type BulkTaskUpdate,
} from './crudUpdateValidation.js';
import {
  applyProjectScopedUpsert,
  classifyUpsertTarget,
} from './crudUpdateUpsert.js';

export { appendSummaryText, classifyUpsertTarget };

// Accepts EITHER a JSON body ({title?, description?, status?}) OR a
// text/markdown / text/plain body. The body helper owns the markdown grammar:
// first heading ⇒ title + description, no heading ⇒ description replacement.
// This is the killer ergonomics path for shell agents — heredoc with
// single-quoted EOF replaces multi-line descriptions with zero escaping.
export async function handleTaskUpdate(
  req: TaskIdRequest,
  res: Response,
): Promise<void> {
  const parsed = taskPatchFromBody(req.body);
  if (!parsed.ok) {
    res.status(400).json({ error: parsed.error });
    return;
  }

  await respondJson(res, async () => {
    // Look the task up before writing so the optional `?project=` pin can
    // refuse a foreign id BEFORE the patch lands (see requestUtils).
    const existing = await getTask(req.params.id);
    if (!existing) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    if (!requireTaskInRequestedProject(existing, req, res)) return;
    const updated = await updateTask(req.params.id, parsed.value);
    if (!updated) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    return updated;
  });
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
  const summary = summaryFromBody(req.body);
  if (summary !== undefined && typeof summary !== 'string') {
    res.status(400).json({ error: 'summary must be a string' });
    return;
  }
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
    if (!requireTaskInRequestedProject(task, req, res)) return;
    // The read-modify-write of `summary` happens inside the task write lock:
    // computing it from the unlocked `task` above let two concurrent appends
    // read the same old summary, and the second write dropped the first.
    const updated = await appendTaskSummary(req.params.id, summary);
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
  updates?: BulkTaskUpdate[];
  project?: string;
}>;

export async function handleTaskBulkUpdate(
  req: BulkUpdateRequest,
  res: Response,
): Promise<void> {
  const parsed = bulkUpdatesFromBody(req.body);
  if (!parsed.ok) {
    res.status(400).json({ error: parsed.error });
    return;
  }
  const all = parsed.value;

  await respondJson(res, async () => {
    // Honour the project pin (query OR body) like the single PATCH does: an id
    // from another board is reported as `foreign`, never written (updateTask
    // is global).
    const { own, foreign } = await partitionIdsByRequestedProject(
      all.map((u) => u.id!),
      resolveProject(req),
    );
    const ownIds = new Set(own);
    const updates = all.filter((u) => ownIds.has(u.id!));
    const results = await Promise.all(
      updates.map(({ id, ...patch }) => updateTask(id!, patch)),
    );
    const updated: Task[] = [];
    const missing: string[] = [];
    results.forEach((r, i) => {
      if (r) updated.push(r);
      else missing.push(updates[i].id!);
    });
    return { updated: updated.length, missing, foreign, tasks: updated };
  });
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
  const check = await validateProjectForCreate(project);
  if (!check.ok) {
    res.status(400).json({ error: check.error });
    return;
  }

  const blocks = upsertBlocksFromBody(req.body);
  const validationError = validateUpsertBlocks(blocks);
  if (validationError) {
    res.status(400).json({ error: validationError });
    return;
  }

  await respondJson(res, () => applyProjectScopedUpsert(check.canonical, blocks));
}
