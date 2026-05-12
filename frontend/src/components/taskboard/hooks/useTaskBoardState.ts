import { useMemo } from 'react';
import type { Task, TaskStatus } from '../../../api';
import { useTaskList } from './useTaskList';
import { useTaskSelection } from './useTaskSelection';

export type GroupedTasks = Record<TaskStatus, Task[]>;

export function compareTasksForLane(a: Task, b: Task): number {
  return (a.sortOrder ?? -a.createdAt) - (b.sortOrder ?? -b.createdAt);
}

export function groupTasksByStatus(tasks: Task[]): GroupedTasks {
  const grouped: GroupedTasks = {
    backlog: [],
    open: [],
    in_progress: [],
    ready_to_merge: [],
    qa: [],
    done: [],
    deleted: [],
  };
  for (const task of tasks) grouped[task.status].push(task);
  for (const status of Object.keys(grouped) as TaskStatus[]) {
    grouped[status].sort(compareTasksForLane);
  }
  return grouped;
}

// Combines task list syncing, lane grouping/sorting, derived board counts,
// and multi-selection into the single state shape consumed by the launcher.
export function useTaskBoardState(activeFolder: string) {
  const { tasks, error, setError, showError } = useTaskList(activeFolder);
  const grouped = useMemo(() => groupTasksByStatus(tasks), [tasks]);
  const selection = useTaskSelection(tasks, grouped);
  const activeCount = useMemo(
    () =>
      tasks.filter(
        (task) =>
          task.status !== 'deleted' &&
          task.status !== 'done' &&
          task.status !== 'backlog',
      ).length,
    [tasks],
  );

  return {
    tasks,
    grouped,
    activeCount,
    error,
    setError,
    showError,
    selected: selection.selectedIds,
    selectedIds: selection.selectedIds,
    clearSelection: selection.clearSelection,
    selectSingle: selection.handleSingleSelect,
    toggleSelect: selection.handleToggleSelect,
    rangeSelect: selection.handleRangeSelect,
  };
}
