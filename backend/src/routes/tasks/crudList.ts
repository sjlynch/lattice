// Listing / project-envelope read handlers: list, summary, search, projects
// index, and single-task fetch. Also home to the foreign-task partitioning that
// every project-scoped read relies on as an integrity check.
//
// These handlers are deliberately thin. The filter/sort/project/clip/measure
// pipeline behind the list and summary lives in `listQuery.ts`, and the search
// scoring in `taskSearch.ts` — both pure, so the progressive-disclosure
// behaviour is unit-testable without an Express app. What stays here is the
// HTTP adapter: read the query, run the pure pipeline, render its outcome.

import type { Request, Response } from 'express';
import {
  getTask,
  listKnownProjects,
  listTasks,
  type Task,
} from '../../tasks.js';
import { canonicalProjectPath, projectHash } from '../../projectPath.js';
import {
  buildListOutcome,
  buildTaskSummary,
  parseListQuery,
  type ListEnvelopeMeta,
} from './listQuery.js';
import {
  buildSearchEnvelope,
  parseSearchQuery,
  searchTasks,
} from './taskSearch.js';
import { requireAbsoluteProject, respondJson } from './requestUtils.js';
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

function logForeignTasks(route: string, canonicalProject: string, foreign: Task[]): void {
  if (foreign.length === 0) return;
  const sample = Array.from(new Set(foreign.map((t) => t.projectPath))).slice(0, 3);
  console.warn(
    `[tasks] ${route}?project=${canonicalProject} filtered ${foreign.length} foreign task(s); sample projectPaths:`,
    sample,
  );
}

// Express hands back `string | string[] | ParsedQs` per key (a repeated param
// arrives as an array). The pure parsers want plain strings, so flatten to the
// string-valued entries and let them apply defaults for everything else.
function stringParams(query: Request['query']): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(query)) {
    if (typeof value === 'string') out[key] = value;
  }
  return out;
}

// Shared project resolution for the read endpoints. Returns the envelope meta
// (minus `mismatched`, which needs the task list) or null once it has sent the
// 400 itself.
function resolveMeta(req: Request, res: Response): { project: string; canonicalProject: string; hash: string } | null {
  const project = typeof req.query.project === 'string' ? req.query.project : '';
  if (!project) {
    res.status(400).json({ error: 'project required' });
    return null;
  }
  if (!requireAbsoluteProject(project, res)) return null;
  const canonicalProject = canonicalProjectPath(project);
  return { project, canonicalProject, hash: projectHash(canonicalProject) };
}

// Response is an envelope ({ project, canonicalProject, hash, count,
// mismatched, tasks, … }) rather than a bare Task[] so agents can assert that
// canonicalProject/hash match the project + hash their LATTICE_API.md names
// before acting on the data — defends against the "filter returned the wrong
// project's tasks" failure mode.
//
// Defaults are the progressive-disclosure ones (active lanes, compact fields,
// newest 100, text clipped at 500 chars) and the response prices itself, so an
// unparameterized GET is cheap orientation rather than the whole board. See
// `listQuery.ts` for the full parameter set.
export async function handleTaskList(
  req: Request,
  res: Response,
): Promise<void> {
  const meta = resolveMeta(req, res);
  if (!meta) return;
  const parsed = parseListQuery(stringParams(req.query));
  if (!parsed.ok) {
    res.status(400).json({ error: parsed.error });
    return;
  }
  await respondJson(res, async () => {
    const all = await listTasks(meta.canonicalProject);
    const { safe, foreign } = partitionByProject(all, meta.canonicalProject);
    logForeignTasks('/api/tasks', meta.canonicalProject, foreign);
    const envelopeMeta: ListEnvelopeMeta = { ...meta, mismatched: foreign.length };
    const outcome = buildListOutcome(envelopeMeta, safe, parsed.value);
    if (outcome.kind === 'markdown') {
      // format=markdown emits a round-trippable document instead of JSON.
      // Pair with POST /api/tasks/upsert to do "GET → edit → POST back" loops
      // without any JSON / shell-quoting in between.
      res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
      res.send(outcome.markdown);
      return;
    }
    if (outcome.kind === 'too-large') {
      res.status(413).json(outcome.body);
      return;
    }
    return outcome.body;
  });
}

export async function handleTaskSummary(
  req: Request,
  res: Response,
): Promise<void> {
  const meta = resolveMeta(req, res);
  if (!meta) return;
  await respondJson(res, async () => {
    const all = await listTasks(meta.canonicalProject);
    const { safe, foreign } = partitionByProject(all, meta.canonicalProject);
    logForeignTasks('/api/tasks/summary', meta.canonicalProject, foreign);
    return buildTaskSummary({ ...meta, mismatched: foreign.length }, safe);
  });
}

// Find without listing. Substring AND-match over title/description/summary
// across EVERY lane by default — history is where most of the interesting
// matches are, and the ~1 KB result is what makes reaching for it cheaper than
// pulling the board.
export async function handleTaskSearch(
  req: Request,
  res: Response,
): Promise<void> {
  const meta = resolveMeta(req, res);
  if (!meta) return;
  const parsed = parseSearchQuery(stringParams(req.query));
  if (!parsed.ok) {
    res.status(400).json({ error: parsed.error });
    return;
  }
  await respondJson(res, async () => {
    const all = await listTasks(meta.canonicalProject);
    const { safe, foreign } = partitionByProject(all, meta.canonicalProject);
    logForeignTasks('/api/tasks/search', meta.canonicalProject, foreign);
    return buildSearchEnvelope(
      { ...meta, mismatched: foreign.length },
      parsed.value,
      searchTasks(safe, parsed.value),
    );
  });
}

// Every project root Lattice has indexed (from ~/.lattice/projects.json).
// Lets a harness-spawned agent see "here are my options" without scanning
// the filesystem — and gives the harness a sanity check if it ends up in
// an ambiguous cwd. Read-only; tiny payload (path + hash only).
export async function handleProjectsList(
  _req: Request,
  res: Response,
): Promise<void> {
  await respondJson(res, async () => {
    const projects = await listKnownProjects();
    return projects.map((p) => {
      const canonical = canonicalProjectPath(p);
      return { path: canonical, hash: projectHash(canonical) };
    });
  });
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
