// The board summary behind GET /api/tasks/summary (and inside every 413): counts
// by lane plus what each lane would cost to fetch.

import type { Task, TaskStatus } from '../../tasks.js';
import { VALID_STATUSES } from './requestUtils.js';
import { ACTIVE_STATUSES, type ListEnvelopeMeta } from './listQueryTypes.js';
import { lastActivityAt } from './listQuerySelect.js';
import { approxTokens, compactTask, jsonBytes } from './listQuerySizing.js';

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
  // The cost of the WHOLE board's full records — deliberately not named
  // `bytes`, which on every other envelope means "this response". A model that
  // read `bytes: 1275734` on a 700-byte summary would believe the summary cost
  // 1.2 MB.
  boardBytes: number;
  boardApproxTokens: number;
  hint: string;
}

function formatBytes(bytes: number): string {
  return bytes >= 1024 ? `${Math.round(bytes / 1024)} KB` : `${bytes} B`;
}

function formatTokens(tokens: number): string {
  return tokens >= 1000 ? `${Math.floor(tokens / 1000)}k tokens` : `${tokens} tokens`;
}

// The orient tier: under a kilobyte that says what the board holds AND what
// each lane would cost to fetch, so the expensive call becomes a decision
// instead of a discovery. `boardBytes` prices the FULL board (every record,
// unclipped); the per-lane `bytes` price each lane the same way.
//
// Cost note: this stringifies every record twice (once per lane, once whole) —
// ~1.3 MB on a mature board, a few ms. Fine for a call made once per session
// (the UI never polls it); a lane-sum shortcut would save one pass at the price
// of a brittle bracket/comma arithmetic that would only ever be approximately
// right anyway.
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

  const boardBytes = jsonBytes(safe);
  return {
    project: meta.project,
    canonicalProject: meta.canonicalProject,
    hash: meta.hash,
    total: safe.length,
    mismatched: meta.mismatched,
    byStatus,
    lanes,
    boardBytes,
    boardApproxTokens: approxTokens(boardBytes),
    hint: sentences.join(' '),
  };
}
