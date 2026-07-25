// Create / batch-create handlers. Batch-create accepts JSON (array or
// {tasks:[...]}) or a markdown body (each `# Heading` starts a task).

import type { Request, Response } from 'express';
import { createTask } from '../../tasks.js';
import { parseMarkdownTasks } from './markdownBatch.js';
import { resolveProject, respondJson } from './requestUtils.js';
import { validateProjectForCreate } from './projectValidation.js';

type TaskDraft = { title: string; description?: string };
// Request bodies are untrusted JSON — fields are `unknown` until validated, so
// a non-string title/description is caught here (a clean 400) instead of
// blowing up on `.trim()` deep in an async handler (a cryptic 500).
type JsonBatchTask = { title?: unknown; description?: unknown };

export async function handleTaskCreate(
  req: Request,
  res: Response,
): Promise<void> {
  const project = resolveProject(req);
  const body = (req.body || {}) as { title?: unknown; description?: unknown };
  const title = body.title;
  const description = body.description;
  if (typeof title !== 'string' || !title.trim()) {
    res.status(400).json({ error: 'title required (must be a non-empty string)' });
    return;
  }
  if (description !== undefined && typeof description !== 'string') {
    res.status(400).json({ error: 'description must be a string' });
    return;
  }
  const check = await validateProjectForCreate(project);
  if (!check.ok) {
    res.status(400).json({ error: check.error });
    return;
  }
  await respondJson(res, () => createTask(check.canonical, title, description));
}

export async function handleTaskBatchCreate(
  req: Request,
  res: Response,
): Promise<void> {
  const project = resolveProject(req);
  const check = await validateProjectForCreate(project);
  if (!check.ok) {
    res.status(400).json({ error: check.error });
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
    // Validate EVERY element up front (title is a non-empty string, description
    // — when present — is a string, and the element itself isn't null). This
    // both returns a clean 400 instead of a `.trim()`-on-a-number TypeError and
    // keeps the batch atomic: no task is created until the whole array is known
    // good, so a bad element can't leave a half-applied 500.
    const drafts: TaskDraft[] = [];
    for (let i = 0; i < arr.length; i++) {
      const t = arr[i] as JsonBatchTask | null | undefined;
      if (!t || typeof t !== 'object') {
        res.status(400).json({ error: `tasks[${i}] must be an object with a title` });
        return;
      }
      if (typeof t.title !== 'string' || !t.title.trim()) {
        res.status(400).json({ error: `tasks[${i}].title is required` });
        return;
      }
      if (t.description !== undefined && typeof t.description !== 'string') {
        res.status(400).json({ error: `tasks[${i}].description must be a string` });
        return;
      }
      drafts.push({ title: t.title.trim(), description: t.description });
    }
    parsed = drafts;
  }
  await respondJson(res, () =>
    Promise.all(parsed.map((t) => createTask(check.canonical, t.title, t.description))),
  );
}
