// Create / batch-create handlers. Batch-create accepts JSON (array or
// {tasks:[...]}) or a markdown body (each `# Heading` starts a task).

import type { Request, Response } from 'express';
import { createTask } from '../../tasks.js';
import { parseMarkdownTasks } from './markdownBatch.js';
import { resolveProject, respondJson } from './requestUtils.js';

type TaskDraft = { title: string; description?: string };
type JsonBatchTask = { title?: string; description?: string };

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
  await respondJson(res, () => createTask(project, title, description));
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
  await respondJson(res, () =>
    Promise.all(parsed.map((t) => createTask(project, t.title, t.description))),
  );
}
