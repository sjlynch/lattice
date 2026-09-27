import type { Task, TaskStatus } from '../../api';

// Pure drag/drop reorder math. Each function takes the destination lane in the
// SAME top-to-bottom order the user sees on the board (i.e. after
// sortTasksForLane) — the drop indices the UI hands us are measured against
// that visible order, so the splice must happen against the very same array or
// the card lands at a different slot than the drop indicator showed. The hook
// (useTaskReorderActions) wires these to the API; tests exercise them directly.

// The selected cards in the SAME top-to-bottom order they appear in their
// source lane. `displayedSourceLane` is that lane's *visible* order (after
// sortTasksForLane); filtering it preserves what the user sees. Ordering the
// block by compareTasksForLane (sortOrder ?? -createdAt) instead would land the
// moved cards internally reordered whenever the lane's visible order diverges
// from createdAt order (e.g. an 'oldest'-sorted lane, or 'recent' where arrival
// stamps differ from createdAt) — and that wrong order would then be persisted
// as the new manual order.
export function selectedTasksInVisibleOrder(
  displayedSourceLane: Task[],
  ids: string[],
): Task[] {
  const idSet = new Set(ids);
  return displayedSourceLane.filter((task) => idSet.has(task.id));
}

// New id ordering after dropping a single card at `targetIndex`. `lane` is the
// destination lane's visible order; `task` may originate from another lane (then
// it isn't already in `lane`). Returns null for a no-op (dropped onto its own
// current slot in the same lane) so the caller can skip the network write.
export function singleDropOrder(
  lane: Task[],
  task: Task,
  targetStatus: TaskStatus,
  targetIndex: number,
): string[] | null {
  const next = lane.slice();
  const fromIdx = next.findIndex((candidate) => candidate.id === task.id);
  let insertAt = targetIndex;
  if (fromIdx !== -1) {
    next.splice(fromIdx, 1);
    if (fromIdx < insertAt) insertAt -= 1;
  }
  insertAt = Math.max(0, Math.min(insertAt, next.length));
  if (fromIdx === insertAt && task.status === targetStatus) return null;
  next.splice(insertAt, 0, task);
  return next.map((candidate) => candidate.id);
}

// New id ordering after dropping several cards (`srcTasks`, already in lane
// order) at `targetIndex`. `lane` is the destination's visible order; `ids` is
// the set being moved (so the insert point can be corrected for any of them
// that sit above `targetIndex` in `lane`).
export function multiDropOrder(
  lane: Task[],
  srcTasks: Task[],
  ids: string[],
  targetIndex: number,
): string[] {
  const remaining = lane.filter((task) => !ids.includes(task.id));
  let insertAt = targetIndex;
  for (let i = 0; i < targetIndex && i < lane.length; i++) {
    if (ids.includes(lane[i].id)) insertAt--;
  }
  insertAt = Math.max(0, Math.min(insertAt, remaining.length));
  remaining.splice(insertAt, 0, ...srcTasks);
  return remaining.map((task) => task.id);
}

// New id ordering after moving several cards into a lane with no explicit slot
// (append to the end). `lane` is the destination's visible order.
export function appendOrder(lane: Task[], srcTasks: Task[], ids: string[]): string[] {
  const newLane = lane.filter((task) => !ids.includes(task.id));
  newLane.push(...srcTasks);
  return newLane.map((task) => task.id);
}

// Translate a drop slot measured against the lane's *visible* (search-filtered)
// order into the equivalent slot in the full, unfiltered lane. While the board
// search is active the Lane renders only the matching cards, so its slot index
// counts visible cards only; splicing that index into the full lane would land
// the card beside hidden neighbours instead of where the indicator showed. The
// slot is anchored on the first visible card at/after it that isn't being moved
// (the card lands directly above that anchor); with no such card it lands right
// after the last visible card. Both lanes must be in display order
// (sortTasksForLane) — `visibleLane` is a subsequence of `fullLane`.
export function fullLaneDropIndex(
  fullLane: Task[],
  visibleLane: Task[],
  targetIndex: number,
  movingIds: string[] = [],
): number {
  // Unfiltered: the visible lane IS the full lane.
  if (visibleLane.length === fullLane.length) return targetIndex;
  const fullIndexOf = (id: string) =>
    fullLane.findIndex((candidate) => candidate.id === id);
  for (let i = Math.max(0, targetIndex); i < visibleLane.length; i++) {
    if (movingIds.includes(visibleLane[i].id)) continue;
    const idx = fullIndexOf(visibleLane[i].id);
    if (idx !== -1) return idx;
  }
  for (let i = visibleLane.length - 1; i >= 0; i--) {
    const idx = fullIndexOf(visibleLane[i].id);
    if (idx !== -1) return idx + 1;
  }
  return fullLane.length;
}
