// Sizing + projection: the byte/token measures every envelope prices itself
// with, and the two per-task shapes a list returns (compact, or full + clipped).

import type { Task, TaskStatus } from '../../tasks.js';
import { lastActivityAt } from './listQuerySelect.js';

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
