// Selection: filter a project's tasks by the parsed query, sort newest-first by
// last activity (`ids=` keeps request order), and cut the page — plus the `omitted` / `missing` accounting.

import type { Task } from '../../tasks.js';
import { HISTORY_STATUSES, type ListQuery } from './listQueryTypes.js';

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
  /** The page actually returned: newest first (`ids=`: request order), after `limit`. */
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

  // `since` never applies in ids mode: the caller named the tasks it wants, and
  // silently dropping one of them (with no `missing` entry, since it exists)
  // is the worst of both worlds.
  const floor = q.ids ? null : q.since;
  if (floor !== null) {
    matched = matched.filter((t) => lastActivityAt(t) >= floor);
  }

  // An id lookup comes back in the order it was asked for (so a `limit` cuts
  // the tail of the request, not the least-recently-active ids); every other
  // listing is newest-first.
  if (!q.ids) matched.sort((a, b) => lastActivityAt(b) - lastActivityAt(a));
  const page = q.limit > 0 ? matched.slice(0, q.limit) : matched;

  const selection: ListSelection = {
    tasks: page,
    total: safe.length,
    matched: matched.length,
    truncated: page.length < matched.length,
  };
  if (q.statusDefaulted) {
    // Counted over the same `since` window as the result, so the number
    // answers "how many would status=done add to THIS query" — not "how many
    // done tasks exist", which the summary already reports.
    const pool = floor !== null ? safe.filter((t) => lastActivityAt(t) >= floor) : safe;
    const omitted: Record<string, number> = {};
    for (const status of HISTORY_STATUSES) {
      omitted[status] = pool.reduce((n, t) => (t.status === status ? n + 1 : n), 0);
    }
    selection.omitted = omitted;
  }
  if (missing) selection.missing = missing;
  return selection;
}
