// Plain CRUD / list / batch / transition / reorder routes for tasks.
// No worktree spawning, no merge orchestration — just data manipulation.

import { Router, text as textBodyParser } from 'express';
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

const VALID_STATUSES: TaskStatus[] = [
  'backlog', 'open', 'in_progress', 'ready_to_merge', 'qa', 'done', 'deleted',
];

// Resolve `project` from query string first (preferred — keeps the body
// pure data) then fall back to the body. Lets shell agents put project
// in the URL where it's easy to URL-encode and stop wrestling JSON for
// it on every call.
function resolveProject(req: { query: unknown; body: unknown }): string {
  const q = req.query as Record<string, unknown> | null;
  const b = req.body as Record<string, unknown> | string | null;
  if (q && typeof q.project === 'string' && q.project) return q.project;
  if (b && typeof b === 'object' && typeof (b as Record<string, unknown>).project === 'string') {
    return (b as Record<string, string>).project;
  }
  return '';
}

// Parse a markdown body into a list of {title, description?} tasks. Each
// `# ` heading starts a new task; lines below it (until the next heading)
// are the description. Lines before the first heading are ignored.
//
// Why this exists: building a JSON array of tasks with multi-line
// descriptions in a shell is brutal — every backslash, quote, and
// newline needs escaping. A heredoc with single-quoted EOF passes
// markdown through *literally*, no escaping at all. This is the
// difference between a 5-line curl invocation and a 300-line python
// script when an agent wants to seed many tasks at once.
export function parseMarkdownTasks(md: string): Array<{ title: string; description?: string }> {
  const lines = md.split(/\r?\n/);
  const out: Array<{ title: string; description: string[] }> = [];
  let current: { title: string; description: string[] } | null = null;
  for (const line of lines) {
    const heading = /^#\s+(.+?)\s*$/.exec(line);
    if (heading) {
      if (current) out.push(current);
      current = { title: heading[1], description: [] };
    } else if (current) {
      current.description.push(line);
    }
    // pre-heading lines are dropped intentionally
  }
  if (current) out.push(current);
  return out
    .filter((t) => t.title.trim())
    .map((t) => {
      const desc = t.description.join('\n').trim();
      return desc ? { title: t.title, description: desc } : { title: t.title };
    });
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
  r.get('/api/tasks/summary', async (req, res) => {
    const project = typeof req.query.project === 'string' ? req.query.project : '';
    if (!project) return res.status(400).json({ error: 'project required' });
    try {
      const all = await listTasks(project);
      const counts: Record<string, number> = {};
      for (const t of all) counts[t.status] = (counts[t.status] ?? 0) + 1;
      res.json({ total: all.length, byStatus: counts });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

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
    async (req, res) => {
      const project = resolveProject(req);
      if (!project) {
        return res.status(400).json({ error: 'project required (query string or JSON body)' });
      }
      let parsed: Array<{ title: string; description?: string }>;
      if (typeof req.body === 'string') {
        parsed = parseMarkdownTasks(req.body);
        if (parsed.length === 0) {
          return res.status(400).json({
            error: 'no tasks parsed from markdown body — use `# Heading` lines to mark each task',
          });
        }
      } else {
        const body = (req.body || {}) as { tasks?: Array<{ title?: string; description?: string }> };
        // Allow a bare array as the body (when project comes from query).
        const arr = Array.isArray(req.body) ? req.body : body.tasks;
        if (!Array.isArray(arr) || arr.length === 0) {
          return res.status(400).json({ error: 'tasks must be a non-empty array' });
        }
        const invalid = arr.findIndex((t: { title?: string }) => !t.title?.trim());
        if (invalid !== -1) {
          return res.status(400).json({ error: `tasks[${invalid}].title is required` });
        }
        parsed = arr.map((t: { title?: string; description?: string }) => ({
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
    },
  );

  // Bulk status transition. Saves agents from N PATCH round trips when
  // they're shepherding a batch of tasks (e.g. "mark every qa task done"
  // after reviewing the lane). Either explicit `ids` OR `fromStatus` +
  // `project` to target everything in a lane. Idempotent: tasks already
  // at the target status are no-op.
  r.post('/api/tasks/transition', async (req, res) => {
    const body = (req.body || {}) as {
      ids?: string[];
      status?: TaskStatus;
      fromStatus?: TaskStatus;
    };
    const project = resolveProject(req);
    const status = body.status;
    if (!status || !VALID_STATUSES.includes(status)) {
      return res.status(400).json({
        error: `status must be one of: ${VALID_STATUSES.join(', ')}`,
      });
    }
    let ids: string[];
    if (Array.isArray(body.ids) && body.ids.length > 0) {
      ids = body.ids;
    } else if (body.fromStatus && project) {
      if (!VALID_STATUSES.includes(body.fromStatus)) {
        return res.status(400).json({ error: `fromStatus must be one of: ${VALID_STATUSES.join(', ')}` });
      }
      const all = await listTasks(project);
      ids = all.filter((t) => t.status === body.fromStatus).map((t) => t.id);
    } else {
      return res.status(400).json({
        error: 'provide either { ids: [...] } or { fromStatus, project }',
      });
    }
    if (ids.length === 0) {
      return res.json({ updated: 0, missing: [], ids: [] });
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
  });

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
