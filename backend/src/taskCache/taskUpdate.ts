import type { Task, TaskUpdates } from './types.js';

export type AppliedTaskUpdate = {
  updated: Task;
  updatedList: Task[];
};

export type TaskLookup = {
  project: string;
  tasks: Task[];
  idx: number;
  task: Task;
};

// Stamp a task update with `updatedAt` and any status-transition timestamp the
// caller didn't provide explicitly. Keeps the timestamps aligned regardless of
// which endpoint flipped the status (e.g. /run sets startedAt, but a manual
// PATCH /api/tasks/:id with status=in_progress would otherwise miss it).
export function stampTimestamps(prev: Task, updates: TaskUpdates): TaskUpdates {
  const now = Date.now();
  const out: TaskUpdates = {
    ...updates,
    updatedAt: now,
  };
  const newStatus = updates.status ?? prev.status;
  if (newStatus !== prev.status) {
    if (newStatus === 'in_progress' && updates.startedAt === undefined && !prev.startedAt) {
      out.startedAt = now;
    }
    if (newStatus === 'ready_to_merge' && updates.completedAt === undefined && !prev.completedAt) {
      out.completedAt = now;
    }
    if (newStatus === 'qa' && updates.mergedAt === undefined && !prev.mergedAt) {
      out.mergedAt = now;
    }
    if (newStatus === 'done' && updates.doneAt === undefined && !prev.doneAt) {
      out.doneAt = now;
    }
  }
  return out;
}

export function applyTaskUpdate(
  tasks: Task[],
  idx: number,
  updates: TaskUpdates,
): AppliedTaskUpdate {
  const prev = tasks[idx];
  const stamped = stampTimestamps(prev, updates);
  const updated: Task = {
    ...prev,
    ...stamped,
    id: prev.id,
    projectPath: prev.projectPath,
    createdAt: prev.createdAt,
  };
  return {
    updated,
    updatedList: tasks.map((t, i) => (i === idx ? updated : t)),
  };
}

// Join a new summary onto whatever's already in the task's `summary` field.
// Multiple appends (the worktree agent's change summary, then a QA verdict)
// are stacked newest-last and separated by a horizontal rule so they stay
// visually distinct. Pure + exported so it can be unit-tested in isolation;
// `TaskCacheManager.appendTaskSummary` applies it under the write lock.
export function appendSummaryText(existing: string | undefined, addition: string): string {
  const prev = existing?.trim() || '';
  const next = addition.trim();
  return prev ? `${prev}\n\n---\n\n${next}` : next;
}
