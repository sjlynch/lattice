// Up-front validation for task update routes. These checks intentionally run
// before any write so bulk/upsert requests either apply completely or fail with
// the same 400 response shapes the route historically returned.

import { isValidTaskStatus, statusValidationError } from './requestUtils.js';
import { pickTaskPatch, taskPatchFieldError, type TaskPatch } from './crudTypes.js';
import type { ParsedTaskBlock } from './markdownBatch.js';

export type BulkTaskUpdate = { id?: string } & TaskPatch;

export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

export function bulkUpdatesFromBody(body: unknown): ValidationResult<BulkTaskUpdate[]> {
  const updates = ((body ?? {}) as { updates?: BulkTaskUpdate[] }).updates;
  if (!Array.isArray(updates) || updates.length === 0) {
    return { ok: false, error: 'updates must be a non-empty array' };
  }
  // Whitelist each update onto {id, title, description, status}. Returning the
  // caller's objects verbatim let the handler spread arbitrary internal fields
  // (worktreePath/branch/conflict/…) into updateTask — a mass-assignment hole.
  const projected: BulkTaskUpdate[] = [];
  for (let i = 0; i < updates.length; i++) {
    const u = updates[i];
    if (!u || typeof u.id !== 'string' || !u.id.trim()) {
      return { ok: false, error: `updates[${i}].id is required` };
    }
    if (u.status !== undefined && !isValidTaskStatus(u.status)) {
      return { ok: false, error: `updates[${i}].${statusValidationError('status')}` };
    }
    const fieldError = taskPatchFieldError(u);
    if (fieldError) return { ok: false, error: `updates[${i}].${fieldError}` };
    projected.push({ id: u.id, ...pickTaskPatch(u) });
  }
  return { ok: true, value: projected };
}

export function validateUpsertBlocks(blocks: ParsedTaskBlock[]): string | null {
  if (blocks.length === 0) {
    return 'no tasks parsed — markdown body needs `# Heading` lines, or JSON body needs {tasks:[...]}';
  }
  for (let i = 0; i < blocks.length; i++) {
    // JSON upsert bodies (`{tasks:[...]}`) reach here cast as ParsedTaskBlock
    // without prior shape-checking, so an element may be null or carry a
    // non-string title/description. Guard those before `.trim()` so a bad
    // payload is a clean 400, not a `.trim()`-on-a-number / read-of-null 500.
    const b = blocks[i] as ParsedTaskBlock | null | undefined;
    if (!b || typeof b !== 'object') {
      return `tasks[${i}] must be an object with a title`;
    }
    if (b.id !== undefined && typeof b.id !== 'string') {
      return `tasks[${i}].id must be a string`;
    }
    // A block that UPDATES (has an id) may leave the title out — a status-only
    // `# {id=t_1, status=done}` keeps the existing title. Only a create needs one.
    if (b.title !== undefined && typeof b.title !== 'string') {
      return `tasks[${i}].title must be a string`;
    }
    if (!b.id && !b.title?.trim()) {
      return `tasks[${i}].title is required`;
    }
    if (b.description !== undefined && typeof b.description !== 'string') {
      return `tasks[${i}].description must be a string`;
    }
    if (b.status !== undefined && !isValidTaskStatus(b.status)) {
      return `tasks[${i}].${statusValidationError('status')}`;
    }
  }
  return null;
}
