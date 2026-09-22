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

// Type-check the text fields BEFORE pickTaskPatch casts them through. The
// JSON write paths used to persist `{"title": null}` / `123` / `""` verbatim,
// and a non-string title then 500'd every later `/api/tasks/search` on the
// board (`task.title.toLowerCase()`) and the `/run` terminal label. Returns the
// 400 message, or null when the fields are well-formed (status is validated
// separately by the callers, as before).
export function taskPatchFieldError(raw: unknown): string | null {
  const src = (raw ?? {}) as Record<string, unknown>;
  if (src.title !== undefined && (typeof src.title !== 'string' || !src.title.trim())) {
    return 'title must be a non-empty string';
  }
  if (src.description !== undefined && typeof src.description !== 'string') {
    return 'description must be a string';
  }
  return null;
}
