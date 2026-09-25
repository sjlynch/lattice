// Query parsing for GET /api/tasks: `req.query` strings → a validated
// `ListQuery`, or the 400 message naming what was wrong. `parseStatusParam` is
// shared with the search route.

import type { TaskStatus } from '../../tasks.js';
import { isValidTaskStatus, statusValidationError } from './requestUtils.js';
import {
  ACTIVE_STATUSES,
  DEFAULT_CLIP_CHARS,
  DEFAULT_LIST_LIMIT,
  MAX_LIST_LIMIT,
  type ListQuery,
  type ParseResult,
  type RawListQuery,
} from './listQueryTypes.js';

function csv(raw: string | undefined): string[] | null {
  if (typeof raw !== 'string') return null;
  const parts = raw.split(',').map((s) => s.trim()).filter(Boolean);
  return parts.length > 0 ? parts : null;
}

// `ids=` in request order, first occurrence wins — a repeated id is one task,
// not two copies of it in the response.
function uniqueCsv(raw: string | undefined): string[] | null {
  const parts = csv(raw);
  return parts ? [...new Set(parts)] : null;
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
//
// A bare run of digits is an epoch ONLY at epoch lengths — 13 digits (ms) or 10
// (seconds, scaled). Anything shorter (`2026`, `20260901`) is far more likely a
// year or a date typed without separators, and reading it as milliseconds makes
// it "since 1970": the filter silently matches everything. Better a 400 that
// names the accepted forms than a no-op the caller can't see.
export function parseSince(raw: string, now: number): number | null {
  const value = raw.trim();
  if (!value) return null;
  const duration = DURATION_RE.exec(value);
  if (duration) {
    const unit = duration[2].toLowerCase() as keyof typeof DURATION_MS;
    return now - Number(duration[1]) * DURATION_MS[unit];
  }
  if (/^\d+$/.test(value)) {
    if (value.length === 13) return Number(value);
    if (value.length === 10) return Number(value) * 1000;
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

// Lane list validation shared by list + search. `all` is accepted in any case;
// anything else must be a real lane, else the caller gets a 400 naming them. A
// typo used to match nothing and return 200 with an empty board — which reads
// as "the lane is empty", the one conclusion a mistyped `in-progress` must not
// lead to now that the list is an agent's primary interface.
export function parseStatusParam(
  raw: string,
): ParseResult<{ all: true } | { all: false; statuses: Set<TaskStatus> } | null> {
  const value = raw.trim();
  if (!value) return { ok: true, value: null };
  if (value.toLowerCase() === 'all') return { ok: true, value: { all: true } };
  const lanes = csv(value) ?? [];
  const bad = lanes.filter((lane) => !isValidTaskStatus(lane));
  if (bad.length > 0) {
    return {
      ok: false,
      error: `${statusValidationError('status')}, or "all" — got ${bad.map((b) => JSON.stringify(b)).join(', ')}`,
    };
  }
  return { ok: true, value: { all: false, statuses: new Set(lanes as TaskStatus[]) } };
}

export function parseListQuery(raw: RawListQuery, now = Date.now()): ParseResult<ListQuery> {
  const ids = uniqueCsv(raw.ids);

  // `ids=` is the expand tier: it addresses specific tasks, so a lane filter
  // (or a `since` window, applied in selectTasks) could only ever surprise the
  // caller with an empty result.
  let statuses: ReadonlySet<TaskStatus> | null = null;
  let statusDefaulted = false;
  let statusLabel: string | undefined;
  if (!ids) {
    const status = parseStatusParam(raw.status ?? '');
    if (!status.ok) return status;
    if (status.value === null) {
      statuses = new Set<TaskStatus>(ACTIVE_STATUSES);
      statusDefaulted = true;
      statusLabel = ACTIVE_STATUSES.join(',');
    } else if (status.value.all) {
      statusLabel = 'all';
    } else {
      statuses = status.value.statuses;
      statusLabel = [...status.value.statuses].join(',');
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

  // `ids=` is the EXPAND tier — the caller named these tasks because it wants
  // their text — so the clip default is off there, like `fields` defaults to
  // `full`. (Otherwise the clipped-text hint would point at `?ids=` for the
  // full text, and `?ids=` would clip again: a loop.)
  const clip = parseNonNegativeInt(raw.clip, ids ? 0 : DEFAULT_CLIP_CHARS, 'clip');
  if (!clip.ok) return clip;
  // Same reasoning for `limit`: an id lookup is exact — the caller treats the
  // result as "these tasks", so a default page cap would silently drop some of
  // them (a `truncated` flag is easy to miss). The 256 KB ceiling still guards
  // the size; an explicit `limit=` is still honoured.
  const limit = parseNonNegativeInt(raw.limit, ids ? 0 : DEFAULT_LIST_LIMIT, 'limit');
  if (!limit.ok) return limit;

  let since: number | null = null;
  if (typeof raw.since === 'string' && raw.since.trim()) {
    since = parseSince(raw.since, now);
    if (since === null) {
      return {
        ok: false,
        error:
          'since must be an ISO-8601 timestamp, epoch milliseconds (13 digits) or ' +
          `seconds (10 digits), or a duration like 30d / 12h / 45m, got ${JSON.stringify(raw.since)}`,
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
