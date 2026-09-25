// Pure query logic behind GET /api/tasks (and the summary's per-lane costing).
// Express never reaches in here: everything takes plain data (a Task[] plus
// already-parsed params) and returns plain data, so the whole
// filter/sort/project/clip/measure pipeline is unit-testable and the handler in
// `crudList.ts` stays a thin adapter.
//
// The shape of this module IS the progressive-disclosure contract. The board on
// a mature project is ~500 tasks / >1 MB of description text, and an agent that
// GETs it unfiltered burns ~320k tokens before it has read a word. So the list
// is scoped to the ACTIVE lanes, compact, newest-first and capped by default;
// every response prices itself (`bytes` / `approxTokens`) and carries a `hint`
// naming the knob that widens it; and anything that would still blow past
// `LIST_RESPONSE_CEILING_BYTES` comes back as a 413 that hands the caller the
// cheap summary instead of the payload.

//
// The stages live in flat siblings, dependency order types/constants ←
// parse / select / sizing ← envelope / summary ← this outcome step:
// `listQueryTypes.ts`, `listQueryParse.ts`, `listQuerySelect.ts`,
// `listQuerySizing.ts`, `listQueryEnvelope.ts`, `listQuerySummary.ts`. This
// file re-exports all of them, so callers keep importing from here.

import type { Task } from '../../tasks.js';
import { serializeTasksAsMarkdown } from './markdownBatch.js';
import {
  LIST_RESPONSE_CEILING_BYTES,
  type ListEnvelopeMeta,
  type ListQuery,
} from './listQueryTypes.js';
import { selectTasks } from './listQuerySelect.js';
import { approxTokens, utf8Bytes } from './listQuerySizing.js';
import { buildListEnvelopeJson, type ListEnvelope } from './listQueryEnvelope.js';
import { buildTaskSummary, type TaskSummary } from './listQuerySummary.js';

export {
  ACTIVE_STATUSES,
  DEFAULT_CLIP_CHARS,
  DEFAULT_LIST_LIMIT,
  LIST_RESPONSE_CEILING_BYTES,
  MAX_LIST_LIMIT,
  type ListEnvelopeMeta,
  type ListQuery,
  type ParseResult,
  type RawListQuery,
} from './listQueryTypes.js';
export { parseListQuery, parseSince, parseStatusParam } from './listQueryParse.js';
export { lastActivityAt, selectTasks, type ListSelection } from './listQuerySelect.js';
export {
  approxTokens,
  clipTask,
  compactTask,
  jsonBytes,
  utf8Bytes,
  type ClippedTask,
  type CompactTask,
} from './listQuerySizing.js';
export {
  buildListEnvelope,
  buildListEnvelopeJson,
  composeListHint,
  type ListEnvelope,
  type ListHintInput,
} from './listQueryEnvelope.js';
export { buildTaskSummary, type LaneCost, type TaskSummary } from './listQuerySummary.js';

// ---------------------------------------------------------------- outcome --

export interface TooLargeBody {
  error: 'response-too-large';
  bytes: number;
  approxTokens: number;
  ceilingBytes: number;
  summary: TaskSummary;
  suggestions: string[];
  hint: string;
}

// The 413 is the teaching moment, so it pays for itself: it carries the whole
// summary payload (the call the caller should have made) plus the exact knobs,
// which means blundering into the ceiling costs one round trip, not two.
export function buildTooLargeBody(bytes: number, summary: TaskSummary): TooLargeBody {
  const tokens = approxTokens(bytes);
  return {
    error: 'response-too-large',
    bytes,
    approxTokens: tokens,
    ceilingBytes: LIST_RESPONSE_CEILING_BYTES,
    summary,
    suggestions: [
      'GET /api/tasks/summary?project=… — counts + per-lane cost (under 1 KB)',
      'add status=open,in_progress (or another lane subset)',
      'add fields=compact',
      'add limit=50 (newest first) or since=30d',
      'use GET /api/tasks/search?q=… to find specific tasks',
      'pass confirm_large=1 to receive the full response anyway',
    ],
    hint: `This response would be ~${tokens} tokens. Narrow it, or confirm_large=1.`,
  };
}

export type ListOutcome =
  // `json` is `body` already serialized (once); send it verbatim.
  | { kind: 'json'; body: ListEnvelope; json: string }
  | { kind: 'markdown'; markdown: string }
  | { kind: 'too-large'; body: TooLargeBody };

// The one entry point the handler calls: filter → project → measure → decide.
// `format=markdown` shares every step except the projection, because that doc
// is round-tripped through POST /api/tasks/upsert (which REPLACES descriptions)
// — clipping it would silently destroy task text on the way back.
export function buildListOutcome(
  meta: ListEnvelopeMeta,
  safe: Task[],
  q: ListQuery,
): ListOutcome {
  const selection = selectTasks(safe, q);
  if (q.format === 'markdown') {
    const markdown = serializeTasksAsMarkdown(
      selection.tasks.map((t) => ({
        id: t.id,
        title: t.title,
        description: t.description,
        status: t.status,
      })),
      {
        canonicalProject: meta.canonicalProject,
        hash: meta.hash,
        statusFilter: q.statusLabel,
      },
    );
    const bytes = utf8Bytes(markdown);
    if (bytes > LIST_RESPONSE_CEILING_BYTES && !q.confirmLarge) {
      return {
        kind: 'too-large',
        body: buildTooLargeBody(bytes, buildTaskSummary(meta, safe)),
      };
    }
    return { kind: 'markdown', markdown };
  }

  const { envelope: body, json } = buildListEnvelopeJson(meta, selection, q);
  if (body.bytes > LIST_RESPONSE_CEILING_BYTES && !q.confirmLarge) {
    return {
      kind: 'too-large',
      body: buildTooLargeBody(body.bytes, buildTaskSummary(meta, safe)),
    };
  }
  return { kind: 'json', body, json };
}
