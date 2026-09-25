// Shared constants + types of the task-list pipeline (`listQuery.ts` and its
// `listQuery*.ts` siblings). A leaf: every other stage imports from here, and
// this imports nothing of theirs, so the split can't grow an import cycle.

import type { TaskStatus } from '../../tasks.js';

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
export const HISTORY_STATUSES = ['done', 'deleted'] as const satisfies readonly TaskStatus[];

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
  /** Max chars of description/summary in `full` mode; 0 = unlimited. Defaults to 0 in `ids=` mode. */
  clip: number;
  /** Epoch-ms floor on `lastActivityAt`, or null. Ignored in `ids=` mode. */
  since: number | null;
  /** Max tasks returned; 0 = unlimited. Defaults to 0 in `ids=` mode. */
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
