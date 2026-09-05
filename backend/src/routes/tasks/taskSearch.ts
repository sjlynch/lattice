// Pure search over a project's tasks, behind GET /api/tasks/search.
//
// The find tier of progressive disclosure: the reason an agent reaches for the
// whole board is almost always "which task was the one about X", and paying
// ~320k tokens to answer that is absurd. Search answers it in ~1 KB and, unlike
// the list, defaults to EVERY lane — history is exactly where the interesting
// matches live. Like `listQuery.ts` this takes plain data and returns plain
// data; the Express adapter lives in `crudList.ts`.

import type { Task, TaskStatus } from '../../tasks.js';
import {
  approxTokens,
  jsonBytes,
  lastActivityAt,
  type ListEnvelopeMeta,
  type ParseResult,
} from './listQuery.js';

export const DEFAULT_SEARCH_LIMIT = 20;
export const MAX_SEARCH_LIMIT = 200;

/** ~160 chars is one readable line of context in a terminal. */
export const SNIPPET_CHARS = 160;
/** How much of the window sits BEFORE the hit, so the match isn't flush left. */
const SNIPPET_LEAD_CHARS = 50;

// A title hit is a much stronger signal than a body hit — task titles are
// deliberately short, so a term appearing in one is nearly always the subject
// rather than an aside.
const TITLE_WEIGHT = 3;

export type RawSearchQuery = Record<string, string | undefined>;

export interface SearchQuery {
  q: string;
  /** Lowercased whitespace-split terms; a task must contain EVERY one. */
  terms: string[];
  /** `null` = every lane, which is the default for search. */
  statuses: ReadonlySet<TaskStatus> | null;
  limit: number;
}

export interface SearchResultItem {
  id: string;
  title: string;
  status: TaskStatus;
  lastActivityAt: number;
  score: number;
  snippet: string;
}

export interface SearchSelection {
  results: SearchResultItem[];
  /** Matched every term, BEFORE `limit`. */
  matched: number;
  truncated: boolean;
}

export interface SearchEnvelope {
  project: string;
  canonicalProject: string;
  hash: string;
  q: string;
  count: number;
  matched: number;
  truncated: boolean;
  bytes: number;
  approxTokens: number;
  hint?: string;
  results: SearchResultItem[];
}

// ---------------------------------------------------------------- parsing --

export function parseSearchQuery(raw: RawSearchQuery): ParseResult<SearchQuery> {
  const q = typeof raw.q === 'string' ? raw.q.trim() : '';
  if (!q) return { ok: false, error: 'q required' };

  const statusParam = (raw.status ?? '').trim();
  let statuses: ReadonlySet<TaskStatus> | null = null;
  if (statusParam && statusParam !== 'all') {
    const lanes = statusParam.split(',').map((s) => s.trim()).filter(Boolean);
    if (lanes.length > 0) statuses = new Set(lanes as TaskStatus[]);
  }

  let limit = DEFAULT_SEARCH_LIMIT;
  if (typeof raw.limit === 'string' && raw.limit.trim()) {
    if (!/^\d+$/.test(raw.limit.trim())) {
      return {
        ok: false,
        error: `limit must be a non-negative integer, got ${JSON.stringify(raw.limit)}`,
      };
    }
    const parsed = Number(raw.limit.trim());
    limit = parsed === 0 ? MAX_SEARCH_LIMIT : Math.min(parsed, MAX_SEARCH_LIMIT);
  }

  return {
    ok: true,
    value: { q, terms: q.toLowerCase().split(/\s+/).filter(Boolean), statuses, limit },
  };
}

// --------------------------------------------------------------- matching --

/** Non-overlapping occurrences of `term` in an already-lowercased `text`. */
function countOccurrences(text: string, term: string): number {
  if (!term) return 0;
  let n = 0;
  let from = 0;
  for (;;) {
    const at = text.indexOf(term, from);
    if (at === -1) return n;
    n += 1;
    from = at + term.length;
  }
}

/** Earliest index at which ANY term occurs, or -1. */
function firstHitIndex(text: string, terms: string[]): number {
  let best = -1;
  for (const term of terms) {
    const at = text.indexOf(term);
    if (at !== -1 && (best === -1 || at < best)) best = at;
  }
  return best;
}

// A window of context around the first hit, with `…` marking each cut end so a
// reader can tell a trimmed snippet from a short description. Interior
// whitespace is collapsed: descriptions are multi-line markdown, and a snippet
// that spans a blank line reads as garbage in a one-line result list.
export function buildSnippet(text: string, terms: string[]): string {
  const hit = firstHitIndex(text.toLowerCase(), terms);
  if (hit === -1) return '';
  let start = Math.max(0, hit - SNIPPET_LEAD_CHARS);
  let end = Math.min(text.length, start + SNIPPET_CHARS);
  start = Math.max(0, Math.min(start, end - SNIPPET_CHARS));
  const body = text.slice(start, end).replace(/\s+/g, ' ').trim();
  return `${start > 0 ? '…' : ''}${body}${end < text.length ? '…' : ''}`;
}

// AND-of-terms substring match over title + description + summary, scored so
// the strongest match sorts first and `lastActivityAt` breaks ties toward the
// task the user most recently touched.
export function searchTasks(safe: Task[], q: SearchQuery): SearchSelection {
  const scored: SearchResultItem[] = [];
  for (const task of safe) {
    if (q.statuses && !q.statuses.has(task.status)) continue;
    const title = task.title.toLowerCase();
    const description = (task.description ?? '').toLowerCase();
    const summary = (task.summary ?? '').toLowerCase();
    let score = 0;
    let matchedEveryTerm = true;
    for (const term of q.terms) {
      const inTitle = countOccurrences(title, term);
      const inDescription = countOccurrences(description, term);
      const inSummary = countOccurrences(summary, term);
      if (inTitle + inDescription + inSummary === 0) {
        matchedEveryTerm = false;
        break;
      }
      score += TITLE_WEIGHT * inTitle + inDescription + inSummary;
    }
    if (!matchedEveryTerm) continue;
    scored.push({
      id: task.id,
      title: task.title,
      status: task.status,
      lastActivityAt: lastActivityAt(task),
      score,
      // Description first, summary as the fallback; a title-only hit gets no
      // snippet at all, because the title is already in the result.
      snippet:
        buildSnippet(task.description ?? '', q.terms) ||
        buildSnippet(task.summary ?? '', q.terms),
    });
  }

  scored.sort((a, b) => b.score - a.score || b.lastActivityAt - a.lastActivityAt);
  const results = q.limit > 0 ? scored.slice(0, q.limit) : scored;
  return { results, matched: scored.length, truncated: results.length < scored.length };
}

// -------------------------------------------------------------- envelope --

export function buildSearchEnvelope(
  meta: ListEnvelopeMeta,
  q: SearchQuery,
  selection: SearchSelection,
): SearchEnvelope {
  // Same seed-then-backfill trick as the list envelope: keys are written in
  // wire order, then measured without the two self-referential ones.
  const envelope: SearchEnvelope = {
    project: meta.project,
    canonicalProject: meta.canonicalProject,
    hash: meta.hash,
    q: q.q,
    count: selection.results.length,
    matched: selection.matched,
    truncated: selection.truncated,
    bytes: 0,
    approxTokens: 0,
    ...(selection.truncated
      ? {
          hint:
            `Showing ${selection.results.length} of ${selection.matched} matches — ` +
            `raise limit= (max ${MAX_SEARCH_LIMIT}) or add more terms.`,
        }
      : {}),
    results: selection.results,
  };
  const { bytes: _bytes, approxTokens: _tokens, ...measurable } = envelope;
  envelope.bytes = jsonBytes(measurable);
  envelope.approxTokens = approxTokens(envelope.bytes);
  return envelope;
}
