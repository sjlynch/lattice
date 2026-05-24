import type { Request, Response } from 'express';
import {
  createTask,
  deleteTask,
  getTask,
  listKnownProjects,
  listTasks,
  reorderTasksInLane,
  updateTask,
  type Task,
  type TaskStatus,
} from '../../tasks.js';
import { canonicalProjectPath, projectHash } from '../../projectPath.js';
import { cleanupWorktreeForTask } from '../../worktree.js';
import { cancelQueuedTaskSpawns, dequeueTaskRun } from './queuedSpawn.js';
import {
  parseMarkdownDoc,
  parseMarkdownTasks,
  serializeTasksAsMarkdown,
  type ParsedTaskBlock,
} from './markdownBatch.js';
import {
  isValidTaskStatus,
  resolveProject,
  statusValidationError,
} from './requestUtils.js';

// Partition a flat task list into those whose canonical projectPath matches
// the queried project and those that don't. Foreign tasks are an integrity
// signal — they mean the on-disk file at this project's hash dir contains
// data tagged for a different project. We filter them out and log a warning
// so an agent never sees foreign tasks but the operator can investigate.
export function partitionByProject(
  all: Task[],
  canonicalProject: string,
): { safe: Task[]; foreign: Task[] } {
  const safe: Task[] = [];
  const foreign: Task[] = [];
  for (const t of all) {
    if (canonicalProjectPath(t.projectPath) === canonicalProject) safe.push(t);
    else foreign.push(t);
  }
  return { safe, foreign };
}

function logForeignTasks(canonicalProject: string, foreign: Task[]): void {
  if (foreign.length === 0) return;
  const sample = Array.from(new Set(foreign.map((t) => t.projectPath))).slice(0, 3);
  console.warn(
    `[tasks] /api/tasks?project=${canonicalProject} filtered ${foreign.length} foreign task(s); sample projectPaths:`,
    sample,
  );
}

type TaskDraft = { title: string; description?: string };
type JsonBatchTask = { title?: string; description?: string };
type TaskIdRequest = Request<{ id: string }>;

// Response is an envelope ({ project, canonicalProject, hash, count,
// mismatched, tasks }) rather than a bare Task[] so agents can assert the
// canonicalProject matches their LATTICE_PROJECT / hash matches their
// LATTICE_PROJECT_HASH before acting on the data — defends against the
// "filter returned the wrong project's tasks" failure mode.
export async function handleTaskList(
  req: Request,
  res: Response,
): Promise<void> {
  const project = typeof req.query.project === 'string' ? req.query.project : '';
  if (!project) {
    res.status(400).json({ error: 'project required' });
    return;
  }
  const canonicalProject = canonicalProjectPath(project);
  const hash = projectHash(canonicalProject);
  // Optional `?status=` filter so callers (esp. AI agents driving the API
  // from a shell) don't have to fetch the whole list and re-filter
  // client-side. Comma-separated for "open,in_progress" style queries.
  const statusParam = typeof req.query.status === 'string' ? req.query.status : '';
  const filter = statusParam
    ? new Set(statusParam.split(',').map((s) => s.trim()).filter(Boolean))
    : null;
  // format=markdown emits a round-trippable document instead of JSON.
  // Pair with POST /api/tasks/upsert to do "GET → edit → POST back" loops
  // without any JSON / shell-quoting in between.
  const format = typeof req.query.format === 'string' ? req.query.format : 'json';
  try {
    const all = await listTasks(canonicalProject);
    const { safe, foreign } = partitionByProject(all, canonicalProject);
    logForeignTasks(canonicalProject, foreign);
    const tasks = filter ? safe.filter((t) => filter.has(t.status)) : safe;
    if (format === 'markdown') {
      const md = serializeTasksAsMarkdown(
        tasks.map((t) => ({
          id: t.id,
          title: t.title,
          description: t.description,
          status: t.status,
        })),
        { canonicalProject, hash, statusFilter: statusParam || undefined },
      );
      res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
      res.send(md);
      return;
    }
    res.json({
      project,
      canonicalProject,
      hash,
      count: tasks.length,
      mismatched: foreign.length,
      tasks,
    });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
}

export async function handleTaskSummary(
  req: Request,
  res: Response,
): Promise<void> {
  const project = typeof req.query.project === 'string' ? req.query.project : '';
  if (!project) {
    res.status(400).json({ error: 'project required' });
    return;
  }
  const canonicalProject = canonicalProjectPath(project);
  const hash = projectHash(canonicalProject);
  try {
    const all = await listTasks(canonicalProject);
    const { safe, foreign } = partitionByProject(all, canonicalProject);
    logForeignTasks(canonicalProject, foreign);
    const byStatus: Record<string, number> = {};
    for (const t of safe) byStatus[t.status] = (byStatus[t.status] ?? 0) + 1;
    res.json({
      project,
      canonicalProject,
      hash,
      total: safe.length,
      mismatched: foreign.length,
      byStatus,
    });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
}

// Every project root Lattice has indexed (from ~/.lattice/projects.json).
// Lets a harness-spawned agent see "here are my options" without scanning
// the filesystem — and gives the harness a sanity check if it ends up in
// an ambiguous cwd. Read-only; tiny payload (path + hash only).
export async function handleProjectsList(
  _req: Request,
  res: Response,
): Promise<void> {
  try {
    const projects = await listKnownProjects();
    res.json(
      projects.map((p) => {
        const canonical = canonicalProjectPath(p);
        return { path: canonical, hash: projectHash(canonical) };
      }),
    );
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
}

export async function handleTaskGet(
  req: TaskIdRequest,
  res: Response,
): Promise<void> {
  const task = await getTask(req.params.id);
  if (!task) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  res.json(task);
}

export async function handleTaskCreate(
  req: Request,
  res: Response,
): Promise<void> {
  const project = resolveProject(req);
  const body = (req.body || {}) as { title?: string; description?: string };
  const title = body.title;
  const description = body.description;
  if (!project || !title?.trim()) {
    res.status(400).json({ error: 'project and title required' });
    return;
  }
  try {
    const t = await createTask(project, title, description);
    res.json(t);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
}

export async function handleTaskBatchCreate(
  req: Request,
  res: Response,
): Promise<void> {
  const project = resolveProject(req);
  if (!project) {
    res.status(400).json({ error: 'project required (query string or JSON body)' });
    return;
  }
  let parsed: TaskDraft[];
  if (typeof req.body === 'string') {
    parsed = parseMarkdownTasks(req.body);
    if (parsed.length === 0) {
      res.status(400).json({
        error: 'no tasks parsed from markdown body — use `# Heading` lines to mark each task',
      });
      return;
    }
  } else {
    const body = (req.body || {}) as { tasks?: JsonBatchTask[] };
    // Allow a bare array as the body (when project comes from query).
    const arr = Array.isArray(req.body) ? req.body : body.tasks;
    if (!Array.isArray(arr) || arr.length === 0) {
      res.status(400).json({ error: 'tasks must be a non-empty array' });
      return;
    }
    const invalid = arr.findIndex((t: JsonBatchTask) => !t.title?.trim());
    if (invalid !== -1) {
      res.status(400).json({ error: `tasks[${invalid}].title is required` });
      return;
    }
    parsed = arr.map((t: JsonBatchTask) => ({
      title: t.title!.trim(),
      description: t.description,
    }));
  }
  try {
    const created = await Promise.all(
      parsed.map((t) => createTask(project, t.title, t.description)),
    );
    res.json(created);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
}

export async function handleTaskTransition(
  req: Request,
  res: Response,
): Promise<void> {
  const body = (req.body || {}) as {
    ids?: string[];
    status?: unknown;
    fromStatus?: unknown;
  };
  const project = resolveProject(req);
  const status = body.status;
  const fromStatus = body.fromStatus;
  if (!isValidTaskStatus(status)) {
    res.status(400).json({
      error: statusValidationError('status'),
    });
    return;
  }
  let ids: string[];
  if (Array.isArray(body.ids) && body.ids.length > 0) {
    ids = body.ids;
  } else if (fromStatus && project) {
    if (!isValidTaskStatus(fromStatus)) {
      res.status(400).json({ error: statusValidationError('fromStatus') });
      return;
    }
    const all = await listTasks(project);
    ids = all.filter((t) => t.status === fromStatus).map((t) => t.id);
  } else {
    res.status(400).json({
      error: 'provide either { ids: [...] } or { fromStatus, project }',
    });
    return;
  }
  if (ids.length === 0) {
    res.json({ updated: 0, missing: [], ids: [] });
    return;
  }
  try {
    const results = await Promise.all(ids.map((id) => updateTask(id, { status })));
    const updated: string[] = [];
    const missing: string[] = [];
    results.forEach((r, i) => (r ? updated.push(r.id) : missing.push(ids[i])));
    res.json({ updated: updated.length, missing, ids: updated });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
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
  let updates: { title?: string; description?: string; status?: TaskStatus };
  if (typeof req.body === 'string') {
    const md = req.body;
    const doc = parseMarkdownDoc(md);
    if (doc.tasks.length > 0) {
      const t = doc.tasks[0];
      updates = { title: t.title };
      if (t.description !== undefined) updates.description = t.description;
      if (t.status) {
        if (!isValidTaskStatus(t.status)) {
          res.status(400).json({ error: statusValidationError('status') });
          return;
        }
        updates.status = t.status;
      }
    } else {
      // No heading found — treat the whole body as a description replacement.
      updates = { description: md.trim() };
    }
  } else {
    updates = (req.body || {}) as {
      title?: string;
      description?: string;
      status?: TaskStatus;
    };
  }
  try {
    const updated = await updateTask(req.params.id, updates);
    if (!updated) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
}

export async function handleTaskReorder(
  req: Request,
  res: Response,
): Promise<void> {
  const { project, status, ids } = (req.body || {}) as {
    project?: string;
    status?: TaskStatus;
    ids?: string[];
  };
  if (!project || !status || !Array.isArray(ids)) {
    res.status(400).json({ error: 'project, status, ids required' });
    return;
  }
  try {
    const ok = await reorderTasksInLane(project, status, ids);
    if (!ok) {
      res.status(404).json({ error: 'project not found' });
      return;
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
}

// Accepts EITHER a JSON body ({summary}) OR a text/markdown / text/plain
// body whose whole content becomes the summary. Markdown body lets agents
// pipe long heredoc summaries through curl without any JSON escaping.
export async function handleTaskAppendSummary(
  req: TaskIdRequest,
  res: Response,
): Promise<void> {
  let summary: string | undefined;
  if (typeof req.body === 'string') {
    summary = req.body;
  } else {
    summary = (req.body as { summary?: string } | null)?.summary;
  }
  if (!summary?.trim()) {
    res.status(400).json({ error: 'summary required' });
    return;
  }
  try {
    const task = await getTask(req.params.id);
    if (!task) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    const existing = task.description?.trim() || '';
    const appended = existing
      ? `${existing}\n\n---\n\n**Summary:**\n${summary.trim()}`
      : summary.trim();
    const updated = await updateTask(req.params.id, { description: appended });
    if (!updated) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
}

// Cancel a queued task run: drop it from the spawn queue and clear the
// runQueued flag so it reverts to a plain Open task. Idempotent — a no-op
// for a task that is not queued.
export async function handleTaskCancelQueuedRun(
  req: TaskIdRequest,
  res: Response,
): Promise<void> {
  const task = await getTask(req.params.id);
  if (!task) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  await dequeueTaskRun(req.params.id);
  const updated = await getTask(req.params.id);
  res.json(updated ?? { ok: true });
}

// Bulk update — one round trip for N {id, …} patches. Saves agents from
// the N-PATCH loop when they're refining a backlog. Each update is
// independent; missing IDs are reported in the response but do not fail
// the batch. Like single PATCH, idempotent on no-op updates.
type BulkUpdateRequest = Request<unknown, unknown, {
  updates?: Array<{ id?: string; title?: string; description?: string; status?: TaskStatus }>;
}>;

export async function handleTaskBulkUpdate(
  req: BulkUpdateRequest,
  res: Response,
): Promise<void> {
  const body = (req.body ?? {}) as {
    updates?: Array<{ id?: string; title?: string; description?: string; status?: TaskStatus }>;
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
  try {
    const results = await Promise.all(
      updates.map(({ id, ...patch }) => updateTask(id!, patch)),
    );
    const updated: Task[] = [];
    const missing: string[] = [];
    results.forEach((r, i) => {
      if (r) updated.push(r);
      else missing.push(updates[i].id!);
    });
    res.json({ updated: updated.length, missing, tasks: updated });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
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
  let blocks: ParsedTaskBlock[];
  if (typeof req.body === 'string') {
    const doc = parseMarkdownDoc(req.body);
    blocks = doc.tasks;
  } else {
    const body = (req.body ?? {}) as { tasks?: ParsedTaskBlock[] };
    blocks = Array.isArray(body.tasks) ? body.tasks : [];
  }
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
  try {
    const created: Task[] = [];
    const updated: Task[] = [];
    const missing: string[] = [];
    for (const b of blocks) {
      if (b.id) {
        const patch: { title: string; description?: string; status?: TaskStatus } = {
          title: b.title,
        };
        if (b.description !== undefined) patch.description = b.description;
        if (b.status) patch.status = b.status as TaskStatus;
        const result = await updateTask(b.id, patch);
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
    res.json({
      created: created.length,
      updated: updated.length,
      missing,
      tasks: { created, updated },
    });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
}

export async function handleTaskDelete(
  req: TaskIdRequest,
  res: Response,
): Promise<void> {
  const task = await getTask(req.params.id);
  // Drop any still-pending queued run/resume so the spawn queue does not
  // later try to spawn a worktree for a task that no longer exists.
  cancelQueuedTaskSpawns(req.params.id);
  if (task && task.worktreePath && task.branch) {
    try {
      await cleanupWorktreeForTask(task.projectPath, task.worktreePath, task.branch);
    } catch {
      /* ignore — worktree may have already been removed manually */
    }
  }
  const ok = await deleteTask(req.params.id);
  if (!ok) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  res.json({ ok: true });
}
