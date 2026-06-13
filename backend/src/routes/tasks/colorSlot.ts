// Per-task palette-slot assignment.
//
// Every task that runs in a worktree gets a stable `colorIndex` — the
// smallest non-negative integer not currently claimed by another *active*
// task in the same project. "Active" = the lanes where a task still owns a
// worktree the user might be watching (`in_progress`, `ready_to_merge`,
// plus a conflict-flagged task). Once a task leaves those lanes its slot is
// free for reuse, so a fleet of 80+ concurrent agents still maps onto a
// compact, maximally-distinct range of the palette.
//
// The index is assigned once (at spawn) and persisted on the task, so the
// color never reshuffles when a sibling task finishes — only newly-spawned
// tasks pull from the freed slots.

import type { Task, TaskStatus } from '../../tasks.js';

// Lanes whose tasks still hold a live worktree / color slot.
const ACTIVE_STATUSES: ReadonlySet<TaskStatus> = new Set<TaskStatus>([
  'in_progress',
  'ready_to_merge',
]);

function holdsColorSlot(task: Task): boolean {
  return ACTIVE_STATUSES.has(task.status);
}

// Smallest non-negative integer not used by any active task other than
// `selfId`. `tasks` is the full project task list.
export function assignColorSlot(tasks: readonly Task[], selfId: string): number {
  const used = new Set<number>();
  for (const t of tasks) {
    if (t.id === selfId) continue;
    if (!holdsColorSlot(t)) continue;
    if (typeof t.colorIndex === 'number' && t.colorIndex >= 0) {
      used.add(t.colorIndex);
    }
  }
  let slot = 0;
  while (used.has(slot)) slot++;
  return slot;
}
