// Plain CRUD / list / batch / transition / reorder routes for tasks.
// No worktree spawning, no merge orchestration — just data manipulation.

import { Router, text as textBodyParser, type Request, type Response } from 'express';
import {
  listTasks,
  getTask,
  createTask,
  updateTask,
  deleteTask,
  reorderTasksInLane,
  type TaskStatus,
} from '../../tasks.js';
import { cleanupWorktreeForTask } from '../../worktree.js';
import { parseMarkdownTasks } from './markdownBatch.js';
import {
  isValidTaskStatus,
  resolveProject,
  statusValidationError,
} from './requestUtils.js';

type TaskDraft = { title: string; description?: string };
type JsonBatchTask = { title?: string; description?: string };

async function handleTaskSummary(req: Request, res: Response): Promise<void> {
  const project = typeof req.query.project === 'string' ? req.query.project : '';
  if (!project) {
    res.status(400).json({ error: 'project required' });
    return;
  }
  try {
    const all = await listTasks(project);
    const counts: Record<string, number> = {};
    for (const t of all) counts[t.status] = (counts[t.status] ?? 0) + 1;
    res.json({ total: all.length, byStatus: counts });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
}

async function handleTaskBatchCreate(req: Request, res: Response): Promise<void> {
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

async function handleTaskTransition(req: Request, res: Response): Promise<void> {
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

export function buildTaskCrudRouter(): Router {
  const r = Router();

  r.get('/api/tasks', async (req, res) => {
    const project = typeof req.query.project === 'string' ? req.query.project : '';
    if (!project) return res.status(400).json({ error: 'project required' });
    // Optional `?status=` filter so callers (esp. AI agents driving the API
    // from a shell) don't have to fetch the whole list and re-filter
    // client-side. Comma-separated for "open,in_progress" style queries.
    const statusParam = typeof req.query.status === 'string' ? req.query.status : '';
    const filter = statusParam
      ? new Set(statusParam.split(',').map((s) => s.trim()).filter(Boolean))
      : null;
    try {
      const all = await listTasks(project);
      res.json(filter ? all.filter((t) => filter.has(t.status)) : all);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Counts by status — saves agents from writing a "load-then-tally" script
  // when they just want to know what's on the board.
  // MUST be registered before `/api/tasks/:id`, which would otherwise
  // capture `summary` as an :id and 404.
  r.get('/api/tasks/summary', handleTaskSummary);

  r.get('/api/tasks/:id', async (req, res) => {
    const task = await getTask(req.params.id);
    if (!task) return res.status(404).json({ error: 'not found' });
    res.json(task);
  });

  // Single task. Accepts JSON, form-encoded, or query-string `project`
  // — whichever is easiest to build from the agent's current shell.
  r.post('/api/tasks', async (req, res) => {
    const project = resolveProject(req);
    const body = (req.body || {}) as { title?: string; description?: string };
    const title = body.title;
    const description = body.description;
    if (!project || !title?.trim()) {
      return res.status(400).json({ error: 'project and title required' });
    }
    try {
      const t = await createTask(project, title, description);
      res.json(t);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Batch-create. Accepts EITHER:
  //   - application/json: { project?, tasks: [{title, description?}, ...] }
  //     or just [{title, description?}, ...] when project is in the query.
  //   - text/markdown: each `# Heading` starts a new task, lines below
  //     it become the description. Project must be in the query string.
  //
  // Markdown is the killer ergonomics path for shell agents: a heredoc
  // with single-quoted 'EOF' passes the body through with zero escaping.
  // Returns the created tasks in declaration order.
  r.post(
    '/api/tasks/batch',
    textBodyParser({ type: 'text/markdown', limit: '1mb' }),
    handleTaskBatchCreate,
  );

  // Bulk status transition. Saves agents from N PATCH round trips when
  // they're shepherding a batch of tasks (e.g. "mark every qa task done"
  // after reviewing the lane). Either explicit `ids` OR `fromStatus` +
  // `project` to target everything in a lane. Idempotent: tasks already
  // at the target status are no-op.
  r.post('/api/tasks/transition', handleTaskTransition);

  r.patch('/api/tasks/:id', async (req, res) => {
    const updates = (req.body || {}) as {
      title?: string;
      description?: string;
      status?: TaskStatus;
    };
    try {
      const updated = await updateTask(req.params.id, updates);
      if (!updated) return res.status(404).json({ error: 'not found' });
      res.json(updated);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  r.post('/api/tasks/reorder', async (req, res) => {
    const { project, status, ids } = (req.body || {}) as {
      project?: string;
      status?: TaskStatus;
      ids?: string[];
    };
    if (!project || !status || !Array.isArray(ids)) {
      return res.status(400).json({ error: 'project, status, ids required' });
    }
    try {
      const ok = await reorderTasksInLane(project, status, ids);
      if (!ok) return res.status(404).json({ error: 'project not found' });
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  r.post('/api/tasks/:id/append-summary', async (req, res) => {
    const { summary } = (req.body || {}) as { summary?: string };
    if (!summary?.trim()) {
      return res.status(400).json({ error: 'summary required' });
    }
    try {
      const task = await getTask(req.params.id);
      if (!task) return res.status(404).json({ error: 'not found' });
      const existing = task.description?.trim() || '';
      const appended = existing
        ? `${existing}\n\n---\n\n**Summary:**\n${summary.trim()}`
        : summary.trim();
      const updated = await updateTask(req.params.id, { description: appended });
      if (!updated) return res.status(404).json({ error: 'not found' });
      res.json(updated);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  r.delete('/api/tasks/:id', async (req, res) => {
    const task = await getTask(req.params.id);
    if (task && task.worktreePath && task.branch) {
      try {
        await cleanupWorktreeForTask(task.projectPath, task.worktreePath, task.branch);
      } catch {
        /* ignore — worktree may have already been removed manually */
      }
    }
    const ok = await deleteTask(req.params.id);
    if (!ok) return res.status(404).json({ error: 'not found' });
    res.json({ ok: true });
  });

  return r;
}
