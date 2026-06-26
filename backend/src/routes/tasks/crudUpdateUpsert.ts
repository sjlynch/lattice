// Project-scoped application of parsed task upsert blocks. The HTTP handler
// validates the document up front, then delegates the mutation loop here so the
// cross-project id guard stays in one focused place.

import {
  createTask,
  getTask,
  updateTask,
  type Task,
  type TaskStatus,
} from '../../tasks.js';
import { canonicalProjectPath } from '../../projectPath.js';
import type { ParsedTaskBlock } from './markdownBatch.js';
import { blockToPatch } from './crudUpdateBody.js';

export type TaskUpsertResult = {
  created: number;
  updated: number;
  missing: string[];
  foreign: string[];
  tasks: {
    created: Task[];
    updated: Task[];
  };
};

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

async function createTaskFromBlock(project: string, block: ParsedTaskBlock): Promise<Task> {
  const task = await createTask(project, block.title, block.description);
  if (block.status && block.status !== task.status) {
    const withStatus = await updateTask(task.id, { status: block.status as TaskStatus });
    return withStatus ?? task;
  }
  return task;
}

export async function applyProjectScopedUpsert(
  project: string,
  blocks: ParsedTaskBlock[],
): Promise<TaskUpsertResult> {
  const canonicalProject = canonicalProjectPath(project);
  const created: Task[] = [];
  const updated: Task[] = [];
  const missing: string[] = [];
  const foreign: string[] = [];

  for (const block of blocks) {
    if (!block.id) {
      created.push(await createTaskFromBlock(project, block));
      continue;
    }

    // Project-scoping guard: only update a task that already belongs to THIS
    // project. updateTask resolves ids across every project, so an unguarded
    // update of a foreign id would silently mutate another project's task.
    // Report missing/foreign distinctly; never update.
    const existing = await getTask(block.id);
    const target = classifyUpsertTarget(existing, canonicalProject);
    if (target === 'missing') {
      missing.push(block.id);
      continue;
    }
    if (target === 'foreign') {
      foreign.push(block.id);
      continue;
    }

    const result = await updateTask(block.id, blockToPatch(block));
    if (result) updated.push(result);
    else missing.push(block.id);
  }

  return {
    created: created.length,
    updated: updated.length,
    missing,
    foreign,
    tasks: { created, updated },
  };
}
