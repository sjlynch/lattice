// Body-shape helpers for the task markdown-ergonomic write routes.
// Keep the route handlers in crudUpdate.ts focused on HTTP status/response
// wiring while this module owns the JSON-or-markdown normalization details.

import type { TaskStatus } from '../../tasks.js';
import type { ParsedTaskBlock } from './markdownBatch.js';
import { isValidTaskStatus, normalizeBody, statusValidationError } from './requestUtils.js';
import type { TaskPatch } from './crudTypes.js';

export type ParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

// Assemble the task-patch from a parsed markdown block. Shared by the single
// PATCH markdown path and the upsert loop. Status is cast through here; callers
// validate it first (PATCH inline, upsert in its up-front validation loop) so an
// invalid value never reaches this.
export function blockToPatch(block: ParsedTaskBlock): TaskPatch {
  const patch: TaskPatch = { title: block.title };
  if (block.description !== undefined) patch.description = block.description;
  if (block.status) patch.status = block.status as TaskStatus;
  return patch;
}

// Accepts EITHER a JSON body ({title?, description?, status?}) OR a
// text/markdown / text/plain body. For markdown:
//   - if the body has a `# Heading`, that heading becomes the new title
//     and the body below it becomes the new description.
//   - if it has no heading, the whole body replaces the description and
//     the title is left alone.
export function taskPatchFromBody(body: unknown): ParseResult<TaskPatch> {
  const parsed = normalizeBody(body);
  if (parsed.kind === 'markdown') {
    const block = parsed.doc.tasks[0];
    if (!block) {
      // No heading found — treat the whole body as a description replacement.
      return { ok: true, value: { description: parsed.source.trim() } };
    }
    if (block.status && !isValidTaskStatus(block.status)) {
      return { ok: false, error: statusValidationError('status') };
    }
    return { ok: true, value: blockToPatch(block) };
  }
  return { ok: true, value: parsed.json as TaskPatch };
}

// Accepts EITHER a JSON body ({summary}) OR a text/markdown / text/plain body
// whose whole content becomes the summary.
export function summaryFromBody(body: unknown): string | undefined {
  const parsed = normalizeBody(body);
  return parsed.kind === 'markdown'
    ? parsed.source
    : (parsed.json as { summary?: string }).summary;
}

// Pull the upsert blocks out of either a markdown round-trip document or a JSON
// body shaped like {tasks:[...]}. Validation is intentionally separate so the
// upsert handler can fail fast before applying any mutations.
export function upsertBlocksFromBody(body: unknown): ParsedTaskBlock[] {
  const parsed = normalizeBody(body);
  return parsed.kind === 'markdown'
    ? parsed.doc.tasks
    : Array.isArray(parsed.json.tasks)
      ? (parsed.json.tasks as ParsedTaskBlock[])
      : [];
}
