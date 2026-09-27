import { useMemo } from 'react';
import type { Task, TaskSpawnedEvent, TaskStatus } from '../../../api';
import { useTaskList } from './useTaskList';

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

// Combines task list syncing, lane grouping/sorting and derived board counts
// into the single state shape consumed by the launcher. `onTaskSpawned` is
// threaded straight to useTaskList so the launcher can lazy-mount a queued
// task's terminal when its pty spawns. Multi-selection lives in
// useTaskBoardDataView, after the search filter, so shift-ranges slice the
// lanes as rendered.
export function useTaskBoardState(
  activeFolder: string,
  onTaskSpawned?: (event: TaskSpawnedEvent) => void,
) {
  const { tasks, error, setError, showError } = useTaskList(
    activeFolder,
    onTaskSpawned,
  );
  const grouped = useMemo(() => groupTasksByStatus(tasks), [tasks]);
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
  };
}
