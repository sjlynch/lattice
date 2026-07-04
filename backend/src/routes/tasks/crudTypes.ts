import type { Request } from 'express';
import type { TaskStatus } from '../../tasks.js';

// Shared across the CRUD handler modules: routes parameterized by task id.
export type TaskIdRequest = Request<{ id: string }>;

// The mutable field set every task-write path narrows the body down to:
// PATCH /api/tasks/:id, bulk-update, and the markdown upsert all accept exactly
// these (title / description / status — never id / projectPath / timestamps).
// Spelled out once here so the three paths can't drift on which fields they
// honor; it was previously written out inline four separate times.
export type TaskPatch = {
  title?: string;
  description?: string;
  status?: TaskStatus;
};

// Project an arbitrary request body onto the TaskPatch whitelist. The JSON
// write paths (PATCH /api/tasks/:id, POST /api/tasks/bulk-update) must honor
// ONLY these three fields — casting the raw body straight through was a
// mass-assignment hole: a caller could set internal state like `worktreePath`,
// `branch`, `conflict`, `colorIndex`, `sortOrder`, or the transition
// timestamps directly, and a poisoned `worktreePath` corrupts the merge/cleanup
// flow (cleanup kills every PTY under that root, then `git worktree remove`s it).
// Status is copied through as-is; callers validate it (via isValidTaskStatus)
// before this runs, exactly as the markdown/upsert paths do.
export function pickTaskPatch(raw: unknown): TaskPatch {
  const src = (raw ?? {}) as Record<string, unknown>;
  const patch: TaskPatch = {};
  if (src.title !== undefined) patch.title = src.title as string;
  if (src.description !== undefined) patch.description = src.description as string;
  if (src.status !== undefined) patch.status = src.status as TaskStatus;
  return patch;
}
