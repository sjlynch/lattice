// The list envelope: projection + the teaching `hint` + `bytes`/`approxTokens`
// self-pricing, serialized exactly once.

import {
  MAX_LIST_LIMIT,
  type ListEnvelopeMeta,
  type ListQuery,
} from './listQueryTypes.js';
import type { ListSelection } from './listQuerySelect.js';
import {
  approxTokens,
  clipTask,
  compactTask,
  utf8Bytes,
  type ClippedTask,
  type CompactTask,
} from './listQuerySizing.js';

export interface ListEnvelope extends ListEnvelopeMeta {
  count: number;
  total: number;
  matched: number;
  omitted?: Record<string, number>;
  truncated: boolean;
  clipped: number;
  fields: 'compact' | 'full';
  bytes: number;
  approxTokens: number;
  hint?: string;
  missing?: string[];
  tasks: Array<CompactTask | ClippedTask>;
}

export interface ListHintInput {
  omitted?: Record<string, number>;
  truncated: boolean;
  count: number;
  matched: number;
  clipped: number;
  clip: number;
  fields: 'compact' | 'full';
}

// Each sentence names exactly one knob and the information it unlocks.
// Composed rather than templated so a response that is narrow in every
// dimension carries no hint at all — the already-cheap call shouldn't lecture.
export function composeListHint(args: ListHintInput): string | undefined {
  const sentences: string[] = [];
  const done = args.omitted?.done ?? 0;
  const deleted = args.omitted?.deleted ?? 0;
  if (args.omitted && done + deleted > 0) {
    sentences.push(
      `${done} done and ${deleted} deleted tasks omitted by default — ` +
        'pass status=done or status=all to include them ' +
        '(add since=30d or limit= to bound it).',
    );
  }
  if (args.truncated) {
    sentences.push(
      `Showing ${args.count} of ${args.matched} matching tasks (newest first) — ` +
        `raise limit= (max ${MAX_LIST_LIMIT}, 0 = unlimited) or narrow with since=/status=.`,
    );
  }
  if (args.clipped > 0) {
    sentences.push(
      `${args.clipped} tasks have description/summary clipped at ${args.clip} chars — ` +
        'GET /api/tasks/:id (or ?ids=) for full text, or pass clip=0.',
    );
  }
  if (args.fields === 'compact' && args.count > 0) {
    sentences.push(
      'Compact fields — pass fields=full for descriptions, or GET /api/tasks/:id for one task.',
    );
  }
  return sentences.length > 0 ? sentences.join(' ') : undefined;
}

export function buildListEnvelope(
  meta: ListEnvelopeMeta,
  selection: ListSelection,
  q: ListQuery,
): ListEnvelope {
  return buildListEnvelopeJson(meta, selection, q).envelope;
}

// Project + measure, returning the envelope and its serialized form.
export function buildListEnvelopeJson(
  meta: ListEnvelopeMeta,
  selection: ListSelection,
  q: ListQuery,
): { envelope: ListEnvelope; json: string } {
  let clipped = 0;
  const tasks: Array<CompactTask | ClippedTask> = selection.tasks.map((t) => {
    if (q.fields === 'compact') return compactTask(t);
    const result = clipTask(t, q.clip);
    if (result.clipped) clipped += 1;
    return result.task;
  });
  const hint = composeListHint({
    omitted: selection.omitted,
    truncated: selection.truncated,
    count: tasks.length,
    matched: selection.matched,
    clipped,
    clip: q.clip,
    fields: q.fields,
  });

  // Key insertion order is the wire order, so `bytes`/`approxTokens` are seeded
  // in position and back-filled after measuring the envelope WITHOUT them (per
  // the contract: measure once; don't iterate to a fixed point for a few digits).
  return buildListEnvelopeWithJson(meta, selection, q, tasks, clipped, hint);
}

// The envelope AND its wire form, serialized exactly once. `tasks` is the
// whole cost of a list response (a mature board is >1 MB), and measuring the
// envelope for `bytes` then handing the object to `res.json` stringified it
// twice. The head (every field before `tasks`, a few hundred bytes) is
// stringified twice instead — once without the two self-measurement fields to
// measure, once with them to send — and the task array once.
function buildListEnvelopeWithJson(
  meta: ListEnvelopeMeta,
  selection: ListSelection,
  q: ListQuery,
  tasks: Array<CompactTask | ClippedTask>,
  clipped: number,
  hint: string | undefined,
): { envelope: ListEnvelope; json: string } {
  const head = {
    project: meta.project,
    canonicalProject: meta.canonicalProject,
    hash: meta.hash,
    mismatched: meta.mismatched,
    count: tasks.length,
    total: selection.total,
    matched: selection.matched,
    ...(selection.omitted ? { omitted: selection.omitted } : {}),
    truncated: selection.truncated,
    clipped,
    fields: q.fields,
  };
  const tail = {
    ...(hint ? { hint } : {}),
    ...(selection.missing ? { missing: selection.missing } : {}),
  };
  const tasksJson = JSON.stringify(tasks);
  // `{...head, ...tail, "tasks": [...]}` == the measurable envelope (bytes /
  // approxTokens excluded, per the contract: measure once, no fixed point).
  // Splice the pieces by byte count rather than re-stringifying the tasks.
  const measurableHead = JSON.stringify({ ...head, ...tail });
  const bytes = utf8Bytes(measurableHead) + TASKS_JOINT_BYTES + utf8Bytes(tasksJson);
  const tokens = approxTokens(bytes);
  const fullHead = { ...head, bytes, approxTokens: tokens, ...tail };
  const envelope: ListEnvelope = { ...fullHead, tasks };
  const headJson = JSON.stringify(fullHead);
  const json = `${headJson.slice(0, -1)},"tasks":${tasksJson}}`;
  return { envelope, json };
}

// Byte cost of turning `{...head}` + `[...tasks]` into `{...head,"tasks":[...]}`:
// the `,"tasks":` joint (the head's closing brace is reused as the envelope's).
const TASKS_JOINT_BYTES = Buffer.byteLength(',"tasks":');
