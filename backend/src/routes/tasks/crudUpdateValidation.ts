// Up-front validation for task update routes. These checks intentionally run
// before any write so bulk/upsert requests either apply completely or fail with
// the same 400 response shapes the route historically returned.

import { isValidTaskStatus, statusValidationError } from './requestUtils.js';
import type { TaskPatch } from './crudTypes.js';
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
  for (let i = 0; i < updates.length; i++) {
    const u = updates[i];
    if (!u || typeof u.id !== 'string' || !u.id.trim()) {
      return { ok: false, error: `updates[${i}].id is required` };
    }
    if (u.status !== undefined && !isValidTaskStatus(u.status)) {
      return { ok: false, error: `updates[${i}].${statusValidationError('status')}` };
    }
  }
  return { ok: true, value: updates };
}

export function validateUpsertBlocks(blocks: ParsedTaskBlock[]): string | null {
  if (blocks.length === 0) {
    return 'no tasks parsed — markdown body needs `# Heading` lines, or JSON body needs {tasks:[...]}';
  }
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (!b.title || !b.title.trim()) {
      return `tasks[${i}].title is required`;
    }
    if (b.status !== undefined && !isValidTaskStatus(b.status)) {
      return `tasks[${i}].${statusValidationError('status')}`;
    }
  }
  return null;
}
