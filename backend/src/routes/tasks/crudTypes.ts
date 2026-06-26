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
