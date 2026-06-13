// Listing / project-envelope read handlers: list, summary, projects index,
// and single-task fetch. Also home to the foreign-task partitioning that
// every project-scoped read relies on as an integrity check.

import type { Request, Response } from 'express';
import {
  getTask,
  listKnownProjects,
  listTasks,
  type Task,
} from '../../tasks.js';
import { canonicalProjectPath, projectHash } from '../../projectPath.js';
import { serializeTasksAsMarkdown } from './markdownBatch.js';
import type { TaskIdRequest } from './crudTypes.js';

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
