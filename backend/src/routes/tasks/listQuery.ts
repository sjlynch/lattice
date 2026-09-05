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

import type { Task, TaskStatus } from '../../tasks.js';
import { serializeTasksAsMarkdown } from './markdownBatch.js';
import { VALID_STATUSES } from './requestUtils.js';

// The lanes a board is actively working. `done` and `deleted` are history, and
// on any project older than a few weeks they are >90% of the bytes — so an
// absent `status=` means these five, not everything.
export const ACTIVE_STATUSES = [
  'backlog',
  'open',
  'in_progress',
  'ready_to_merge',
  'qa',
] as const satisfies readonly TaskStatus[];

// The lanes the default filter drops. Reported back as `omitted` so a caller
// sees what it isn't looking at instead of believing the board is small.
const HISTORY_STATUSES = ['done', 'deleted'] as const satisfies readonly TaskStatus[];

/** ~64k tokens. Past this, a list response is a mistake rather than a request. */
export const LIST_RESPONSE_CEILING_BYTES = 256 * 1024;
export const DEFAULT_LIST_LIMIT = 100;
export const MAX_LIST_LIMIT = 1000;
export const DEFAULT_CLIP_CHARS = 500;

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

/** `req.query` reduced to the strings this module understands. */
export type RawListQuery = Record<string, string | undefined>;

export interface ListQuery {
  /** `null` = every lane (explicit `status=all`, or `ids=` mode). */
  statuses: ReadonlySet<TaskStatus> | null;
  /** True when `status=` was absent and ACTIVE_STATUSES was applied for the caller. */
  statusDefaulted: boolean;
  /** The filter actually applied, echoed into the markdown frontmatter. */
  statusLabel?: string;
  ids: string[] | null;
  fields: 'compact' | 'full';
  /** Max chars of description/summary in `full` mode; 0 = unlimited. */
  clip: number;
  /** Epoch-ms floor on `lastActivityAt`, or null. */
  since: number | null;
  /** Max tasks returned; 0 = unlimited. */
  limit: number;
  format: 'json' | 'markdown';
  confirmLarge: boolean;
}

export interface ListEnvelopeMeta {
  project: string;
  canonicalProject: string;
  hash: string;
  mismatched: number;
}

// ---------------------------------------------------------------- parsing --

function csv(raw: string | undefined): string[] | null {
  if (typeof raw !== 'string') return null;
  const parts = raw.split(',').map((s) => s.trim()).filter(Boolean);
  return parts.length > 0 ? parts : null;
}

function parseNonNegativeInt(
  raw: string | undefined,
  fallback: number,
  field: string,
): ParseResult<number> {
  if (raw === undefined || raw.trim() === '') return { ok: true, value: fallback };
  if (!/^\d+$/.test(raw.trim())) {
    return {
      ok: false,
      error: `${field} must be a non-negative integer, got ${JSON.stringify(raw)}`,
    };
  }
  return { ok: true, value: Number(raw.trim()) };
}

const DURATION_RE = /^(\d+)\s*([dhm])$/i;
const DURATION_MS = { d: 86_400_000, h: 3_600_000, m: 60_000 } as const;

// `since` is deliberately generous about its input: an agent composing a curl
// reaches for `30d` far sooner than an ISO timestamp, and a script already
// holding `Date.now() - x` shouldn't have to format one. Returns null for
// anything it can't read, which the caller turns into a 400.
export function parseSince(raw: string, now: number): number | null {
  const value = raw.trim();
  if (!value) return null;
  const duration = DURATION_RE.exec(value);
  if (duration) {
    const unit = duration[2].toLowerCase() as keyof typeof DURATION_MS;
    return now - Number(duration[1]) * DURATION_MS[unit];
  }
  if (/^\d+$/.test(value)) return Number(value);
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

export function parseListQuery(raw: RawListQuery, now = Date.now()): ParseResult<ListQuery> {
  const ids = csv(raw.ids);

  // `ids=` is the expand tier: it addresses specific tasks, so a lane filter
  // could only ever surprise the caller with an empty result.
  let statuses: ReadonlySet<TaskStatus> | null = null;
  let statusDefaulted = false;
  let statusLabel: string | undefined;
  const statusParam = (raw.status ?? '').trim();
  if (!ids) {
    if (statusParam === 'all') {
      statusLabel = 'all';
    } else if (statusParam) {
      statuses = new Set(csv(statusParam) as TaskStatus[]);
      statusLabel = statusParam;
    } else {
      statuses = new Set<TaskStatus>(ACTIVE_STATUSES);
      statusDefaulted = true;
      statusLabel = ACTIVE_STATUSES.join(',');
    }
  }

  const fieldsParam = (raw.fields ?? '').trim().toLowerCase();
  if (fieldsParam && fieldsParam !== 'compact' && fieldsParam !== 'full') {
    return {
      ok: false,
      error: `fields must be "compact" or "full", got ${JSON.stringify(raw.fields)}`,
    };
  }
  const fields: 'compact' | 'full' = fieldsParam
    ? (fieldsParam as 'compact' | 'full')
    : ids
      ? 'full'
      : 'compact';

  const clip = parseNonNegativeInt(raw.clip, DEFAULT_CLIP_CHARS, 'clip');
  if (!clip.ok) return clip;
  const limit = parseNonNegativeInt(raw.limit, DEFAULT_LIST_LIMIT, 'limit');
  if (!limit.ok) return limit;

  let since: number | null = null;
  if (typeof raw.since === 'string' && raw.since.trim()) {
    since = parseSince(raw.since, now);
    if (since === null) {
      return {
        ok: false,
        error:
          'since must be an ISO-8601 timestamp, epoch milliseconds, or a duration ' +
          `like 30d / 12h / 45m, got ${JSON.stringify(raw.since)}`,
      };
    }
  }

  const confirm = (raw.confirm_large ?? '').trim().toLowerCase();
  return {
    ok: true,
    value: {
      statuses,
      statusDefaulted,
      statusLabel,
      ids,
      fields,
      clip: clip.value,
      since,
      // 0 stays 0 (unlimited, by explicit request); anything else is capped.
      limit: limit.value === 0 ? 0 : Math.min(limit.value, MAX_LIST_LIMIT),
      format: raw.format === 'markdown' ? 'markdown' : 'json',
      confirmLarge: confirm === '1' || confirm === 'true' || confirm === 'yes',
    },
  };
}

// -------------------------------------------------------------- selection --

// One timestamp to sort and filter every lane by. A task's meaningful "last
// touched" is whichever lifecycle stamp fired most recently — `updatedAt` alone
// misses a task whose only motion was a transition stamp.
export function lastActivityAt(t: Task): number {
  return Math.max(
    t.createdAt ?? 0,
    t.updatedAt ?? 0,
    t.startedAt ?? 0,
    t.completedAt ?? 0,
    t.mergedAt ?? 0,
    t.doneAt ?? 0,
  );
}

export interface ListSelection {
  /** The page actually returned: newest first, after `limit`. */
  tasks: Task[];
  /** Every task in the project (after the foreign-task partition). */
  total: number;
  /** Matched the status/ids/since filters, BEFORE `limit`. */
  matched: number;
  truncated: boolean;
  /** What the default lane filter dropped; only when `status=` was defaulted. */
  omitted?: Record<string, number>;
  /** Requested ids with no such task; only in `ids=` mode. */
  missing?: string[];
}

export function selectTasks(safe: Task[], q: ListQuery): ListSelection {
  let matched: Task[];
  let missing: string[] | undefined;
  if (q.ids) {
    const byId = new Map(safe.map((t) => [t.id, t] as const));
    matched = [];
    const absent: string[] = [];
    for (const id of q.ids) {
      const found = byId.get(id);
      if (found) matched.push(found);
      else absent.push(id);
    }
    if (absent.length > 0) missing = absent;
  } else if (q.statuses) {
    const wanted = q.statuses;
    matched = safe.filter((t) => wanted.has(t.status));
  } else {
    matched = safe.slice();
  }

  if (q.since !== null) {
    const floor = q.since;
    matched = matched.filter((t) => lastActivityAt(t) >= floor);
  }

  matched.sort((a, b) => lastActivityAt(b) - lastActivityAt(a));
  const page = q.limit > 0 ? matched.slice(0, q.limit) : matched;

  const selection: ListSelection = {
    tasks: page,
    total: safe.length,
    matched: matched.length,
    truncated: page.length < matched.length,
  };
  if (q.statusDefaulted) {
    const omitted: Record<string, number> = {};
    for (const status of HISTORY_STATUSES) {
      omitted[status] = safe.reduce((n, t) => (t.status === status ? n + 1 : n), 0);
    }
    selection.omitted = omitted;
  }
  if (missing) selection.missing = missing;
  return selection;
}

// ------------------------------------------------------------ measurement --

export function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

export function jsonBytes(value: unknown): number {
  return utf8Bytes(JSON.stringify(value) ?? '');
}

/** The usual 4-bytes-per-token rule of thumb; deliberately not a tokenizer. */
export function approxTokens(bytes: number): number {
  return Math.ceil(bytes / 4);
}

// ------------------------------------------------------------ projection --

export interface CompactTask {
  id: string;
  title: string;
  status: TaskStatus;
  createdAt: number;
  updatedAt?: number;
  lastActivityAt: number;
  descriptionBytes: number;
  summaryBytes: number;
  conflict?: boolean;
  runQueued?: boolean;
  workflowRunId?: string;
  harness?: string;
}

// The scan tier: everything an agent needs to decide WHICH task to expand and
// nothing it would have to page through. The two `*Bytes` counters stand in for
// the text, so the cost of expanding is visible before it's paid. The four
// flags ride along only when set, because each changes what the caller can DO
// with the task (resolve it, cancel it, follow its workflow run, re-run it on
// the same harness).
export function compactTask(t: Task): CompactTask {
  const out: CompactTask = {
    id: t.id,
    title: t.title,
    status: t.status,
    createdAt: t.createdAt,
    lastActivityAt: lastActivityAt(t),
    descriptionBytes: t.description ? utf8Bytes(t.description) : 0,
    summaryBytes: t.summary ? utf8Bytes(t.summary) : 0,
  };
  if (t.updatedAt !== undefined) out.updatedAt = t.updatedAt;
  if (t.conflict !== undefined) out.conflict = t.conflict;
  if (t.runQueued !== undefined) out.runQueued = t.runQueued;
  if (t.workflowRunId !== undefined) out.workflowRunId = t.workflowRunId;
  if (t.harness !== undefined) out.harness = t.harness;
  return out;
}

export type ClippedTask = Task & {
  descriptionTruncated?: boolean;
  summaryTruncated?: boolean;
  descriptionBytes?: number;
  summaryBytes?: number;
};

// `full` mode with a budget. The clipped field keeps a trailing `…` so the cut
// is visible in the text itself, and the FULL byte count rides alongside so the
// caller can price the un-clipped fetch (GET /api/tasks/:id) before making it.
export function clipTask(t: Task, clip: number): { task: ClippedTask; clipped: boolean } {
  if (clip <= 0) return { task: t, clipped: false };
  const cutDescription = (t.description?.length ?? 0) > clip;
  const cutSummary = (t.summary?.length ?? 0) > clip;
  if (!cutDescription && !cutSummary) return { task: t, clipped: false };
  const out: ClippedTask = { ...t };
  if (cutDescription) {
    out.descriptionBytes = utf8Bytes(t.description!);
    out.description = t.description!.slice(0, clip) + '…';
    out.descriptionTruncated = true;
  }
  if (cutSummary) {
    out.summaryBytes = utf8Bytes(t.summary!);
    out.summary = t.summary!.slice(0, clip) + '…';
    out.summaryTruncated = true;
  }
  return { task: out, clipped: true };
}

// -------------------------------------------------------------- envelope --

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
  const envelope: ListEnvelope = {
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
    bytes: 0,
    approxTokens: 0,
    ...(hint ? { hint } : {}),
    ...(selection.missing ? { missing: selection.missing } : {}),
    tasks,
  };

  const { bytes: _bytes, approxTokens: _tokens, ...measurable } = envelope;
  envelope.bytes = jsonBytes(measurable);
  envelope.approxTokens = approxTokens(envelope.bytes);
  return envelope;
}

// ---------------------------------------------------------------- summary --

export interface LaneCost {
  count: number;
  bytes: number;
  approxTokens: number;
  newestActivityAt: number;
}

export interface TaskSummary extends ListEnvelopeMeta {
  total: number;
  byStatus: Record<string, number>;
  lanes: Record<string, LaneCost>;
  bytes: number;
  approxTokens: number;
  hint: string;
}

function formatBytes(bytes: number): string {
  return bytes >= 1024 ? `${Math.round(bytes / 1024)} KB` : `${bytes} B`;
}

function formatTokens(tokens: number): string {
  return tokens >= 1000 ? `${Math.floor(tokens / 1000)}k tokens` : `${tokens} tokens`;
}

// The orient tier: ~200 bytes that say what the board holds AND what each lane
// would cost to fetch, so the expensive call becomes a decision instead of a
// discovery. `bytes` here prices the FULL board (every record, unclipped) — it
// is deliberately NOT the size of this response, which is the one place the
// two readings of the field diverge.
export function buildTaskSummary(meta: ListEnvelopeMeta, safe: Task[]): TaskSummary {
  const byStatus: Record<string, number> = {};
  const lanes: Record<string, LaneCost> = {};
  for (const status of VALID_STATUSES) {
    const laneTasks = safe.filter((t) => t.status === status);
    if (laneTasks.length === 0) continue;
    byStatus[status] = laneTasks.length;
    const bytes = jsonBytes(laneTasks);
    lanes[status] = {
      count: laneTasks.length,
      bytes,
      approxTokens: approxTokens(bytes),
      newestActivityAt: laneTasks.reduce((n, t) => Math.max(n, lastActivityAt(t)), 0),
    };
  }

  const active = safe.filter((t) =>
    (ACTIVE_STATUSES as readonly TaskStatus[]).includes(t.status),
  );
  const compactBytes = jsonBytes(active.map(compactTask));
  const sentences = [
    `Active lanes: ${active.length} tasks (~${formatBytes(compactBytes)} compact) ` +
      'via GET /api/tasks?project=….',
  ];
  const done = lanes.done;
  if (done) {
    sentences.push(
      `Done history is ${done.count} tasks (~${formatTokens(done.approxTokens)}) — ` +
        'reach it with status=done plus since=/limit=, or search with ' +
        'GET /api/tasks/search?q=….',
    );
  }

  const bytes = jsonBytes(safe);
  return {
    project: meta.project,
    canonicalProject: meta.canonicalProject,
    hash: meta.hash,
    total: safe.length,
    mismatched: meta.mismatched,
    byStatus,
    lanes,
    bytes,
    approxTokens: approxTokens(bytes),
    hint: sentences.join(' '),
  };
}

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
  | { kind: 'json'; body: ListEnvelope }
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

  const body = buildListEnvelope(meta, selection, q);
  if (body.bytes > LIST_RESPONSE_CEILING_BYTES && !q.confirmLarge) {
    return {
      kind: 'too-large',
      body: buildTooLargeBody(body.bytes, buildTaskSummary(meta, safe)),
    };
  }
  return { kind: 'json', body };
}
