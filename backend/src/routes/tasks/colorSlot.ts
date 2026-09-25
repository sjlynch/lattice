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
// tasks pull from the freed slots. A re-run keeps its stored index only while
// no other active task (or in-flight reservation) holds it: a task that went
// to QA/Done freed its slot, and a sibling may have taken it since.

import type { Task, TaskStatus } from '../../tasks.js';

// Lanes whose tasks still hold a live worktree / color slot.
const ACTIVE_STATUSES: ReadonlySet<TaskStatus> = new Set<TaskStatus>([
  'in_progress',
  'ready_to_merge',
]);

function holdsColorSlot(task: Task): boolean {
  return ACTIVE_STATUSES.has(task.status);
}

// Slots claimed by any active task other than `selfId`, plus `reserved`.
function usedColorSlots(
  tasks: readonly Task[],
  selfId: string,
  reserved: ReadonlySet<number>,
): Set<number> {
  const used = new Set<number>(reserved);
  for (const t of tasks) {
    if (t.id === selfId) continue;
    if (!holdsColorSlot(t)) continue;
    if (typeof t.colorIndex === 'number' && t.colorIndex >= 0) {
      used.add(t.colorIndex);
    }
  }
  return used;
}

function isValidSlot(slot: number | undefined): slot is number {
  return typeof slot === 'number' && Number.isInteger(slot) && slot >= 0;
}

// Smallest non-negative integer not used by any active task other than
// `selfId`. `tasks` is the full project task list; `reserved` are slots
// claimed by spawns whose status flip hasn't landed yet (see below). A
// `preferred` slot (the task's stored index) wins when it is still free.
export function assignColorSlot(
  tasks: readonly Task[],
  selfId: string,
  reserved: ReadonlySet<number> = EMPTY,
  preferred?: number,
): number {
  const used = usedColorSlots(tasks, selfId, reserved);
  if (isValidSlot(preferred) && !used.has(preferred)) return preferred;
  let slot = 0;
  while (used.has(slot)) slot++;
  return slot;
}

const EMPTY: ReadonlySet<number> = new Set();

// In-memory reservations per project. A task being started is still `open`
// until the `updateTask` that flips it, and the spawn queue admits up to
// `softCap` starts concurrently — so two "Run All" siblings whose
// listTasks → updateTask windows overlapped both computed the same lowest
// free slot. Reserving the slot the moment it is chosen (and releasing it
// once the flip has landed, or the start failed) keeps them distinct.
const reservations = new Map<string, Map<string, number>>();

export type ColorSlotReservation = { slot: number; release: () => void };

// `preferred` is the task's stored colorIndex (a re-run, or a CAP-rejected
// first pass): kept when no other active task or reservation holds it, so a
// retry doesn't jump colors — otherwise a free slot is assigned instead.
export function reserveColorSlot(
  projectPath: string,
  tasks: readonly Task[],
  selfId: string,
  preferred?: number,
): ColorSlotReservation {
  let byTask = reservations.get(projectPath);
  if (!byTask) {
    byTask = new Map();
    reservations.set(projectPath, byTask);
  }
  const existing = byTask.get(selfId);
  const others = new Set<number>();
  for (const [id, reserved] of byTask) if (id !== selfId) others.add(reserved);
  const slot = existing ?? assignColorSlot(tasks, selfId, others, preferred);
  byTask.set(selfId, slot);
  let released = false;
  return {
    slot,
    release: () => {
      if (released) return;
      released = true;
      const current = reservations.get(projectPath);
      if (!current) return;
      if (current.get(selfId) === slot) current.delete(selfId);
      if (current.size === 0) reservations.delete(projectPath);
    },
  };
}
