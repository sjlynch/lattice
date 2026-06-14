import type { MergeRunErrorEntry, Task } from '../../api';

// Centralized count + pluralization for the merge-run strip stat chips
// (merged / conflicted / errored) plus the per-task error tooltip. All
// three strip states (active, resolving, summary) format their stats
// through here so the wording stays identical across them.

// Build a multi-line tooltip listing per-task merge errors, resolving
// each taskId to its title (falls back to a short id). Used by the
// "N errors" chip — hovering reveals what actually went wrong.
export function buildErrorsTooltip(
  entries: MergeRunErrorEntry[],
  tasks: Task[],
): string {
  return entries
    .map((entry) => {
      const task = tasks.find((t) => t.id === entry.taskId);
      const label = task?.title?.trim() || entry.taskId.slice(-6);
      return `${label}: ${entry.error}`;
    })
    .join('\n');
}

// "3 merged" — merged is never pluralized in the existing copy.
export function formatMergeStat(count: number): string {
  return `${count} merged`;
}

// "1 conflict" / "2 conflicts"
export function formatConflictStat(count: number): string {
  return `${count} conflict${count === 1 ? '' : 's'}`;
}

// "1 error" / "2 errors"
export function formatErrorStat(count: number): string {
  return `${count} error${count === 1 ? '' : 's'}`;
}
