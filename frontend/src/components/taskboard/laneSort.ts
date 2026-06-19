import type { Task, TaskStatus } from '../../api';

// Per-lane sort mode driving the lane header's clock/caret control.
//   'recent' — by arrival to this lane, newest first (DEFAULT; caret down)
//   'oldest' — by arrival to this lane, oldest first (caret up)
//   'manual' — the drag-reorder order (sortOrder); entered when a card is
//              dropped at an explicit slot, restored to 'recent' via the clock.
export type LaneSortMode = 'recent' | 'oldest' | 'manual';

export const DEFAULT_LANE_SORT: LaneSortMode = 'recent';

// The moment a task arrived in `status`. Each lane has its own arrival stamp:
// in_progress→startedAt, ready_to_merge→completedAt, qa→mergedAt, done→doneAt.
// Lanes with no dedicated stamp (open/backlog) use createdAt; deleted uses the
// last update (when it was binned). Falls back through updatedAt→createdAt so a
// legacy task missing a stamp still sorts sensibly.
export function arrivalTime(task: Task, status: TaskStatus): number {
  switch (status) {
    case 'in_progress':
      return task.startedAt ?? task.updatedAt ?? task.createdAt;
    case 'ready_to_merge':
      return task.completedAt ?? task.updatedAt ?? task.createdAt;
    case 'qa':
      return task.mergedAt ?? task.updatedAt ?? task.createdAt;
    case 'done':
      return task.doneAt ?? task.updatedAt ?? task.createdAt;
    case 'deleted':
      return task.updatedAt ?? task.createdAt;
    case 'backlog':
    case 'open':
    default:
      return task.createdAt;
  }
}

// Sort a lane's tasks for display. 'manual' keeps the incoming order (the
// caller already sorted by sortOrder); 'recent'/'oldest' sort by arrival time
// with createdAt + id as stable tiebreakers.
export function sortTasksForLane(
  tasks: Task[],
  status: TaskStatus,
  mode: LaneSortMode,
): Task[] {
  if (mode === 'manual') return tasks;
  const oldestFirst = mode === 'oldest';
  return [...tasks].sort((a, b) => {
    const ta = arrivalTime(a, status);
    const tb = arrivalTime(b, status);
    if (ta !== tb) return oldestFirst ? ta - tb : tb - ta;
    if (a.createdAt !== b.createdAt) {
      return oldestFirst ? a.createdAt - b.createdAt : b.createdAt - a.createdAt;
    }
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}
