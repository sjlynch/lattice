import type { Task } from '../../api';

// Lanes whose cards show the per-task accent color (matching the task's
// Claude node + worktree rings on the graph). Other lanes keep the plain
// lane-color stripe.
export const ACCENT_STATUSES: ReadonlySet<Task['status']> = new Set([
  'in_progress',
  'ready_to_merge',
]);

export type SelectionClickIntent = 'select' | 'toggle' | 'range';

export type SelectionClickModifiers = {
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
};

export function getTaskDragPayloadIds(
  taskId: string,
  isSelected: boolean,
  selectedIdsInLane: readonly string[],
): string[] {
  return isSelected ? Array.from(selectedIdsInLane) : [taskId];
}

export function getSelectionClickIntent({
  ctrlKey,
  metaKey,
  shiftKey,
}: SelectionClickModifiers): SelectionClickIntent {
  if (ctrlKey || metaKey) return 'toggle';
  if (shiftKey) return 'range';
  return 'select';
}
