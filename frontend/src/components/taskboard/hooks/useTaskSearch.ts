import { useMemo, useState } from 'react';
import { type Task } from '../../../api';
import { groupTasksByStatus, type GroupedTasks } from './useTaskBoardState';

// Lowercased search haystack per Task object. useTaskList structurally shares
// unchanged tasks across `/ws/tasks` frames, so this hits for every task but the
// ones that actually changed — rebuilding all of them (MBs of strings on a large
// board) on every keystroke and frame was pure GC churn. Task objects are never
// mutated in place: a changed task arrives as a new object and misses here.
const haystacks = new WeakMap<Task, string>();

function taskHaystack(task: Task): string {
  let haystack = haystacks.get(task);
  if (haystack === undefined) {
    haystack = `${task.title}\n${task.description ?? ''}\n${
      task.summary ?? ''
    }`.toLowerCase();
    haystacks.set(task, haystack);
  }
  return haystack;
}

function taskContainsSearchText(task: Task, searchText: string): boolean {
  return taskHaystack(task).includes(searchText);
}

// Owns the case-insensitive task search box state and derives the filtered
// task list + status grouping. `searchActive` gates lane "run all" actions so
// they can't fire against a partial view. `grouped` is the caller's existing
// grouping of the same `tasks`; with no search active it is returned as-is
// instead of re-grouping and re-sorting the identical list.
export function useTaskSearch(tasks: Task[], grouped?: GroupedTasks) {
  const [taskSearch, setTaskSearch] = useState('');

  const searchText = taskSearch.trim().toLowerCase();
  const searchActive = searchText.length > 0;

  const filteredTasks = useMemo(
    () =>
      searchActive
        ? tasks.filter((task) => taskContainsSearchText(task, searchText))
        : tasks,
    [searchActive, searchText, tasks],
  );
  const filteredGrouped = useMemo(
    () =>
      !searchActive && grouped ? grouped : groupTasksByStatus(filteredTasks),
    [searchActive, grouped, filteredTasks],
  );

  return {
    taskSearch,
    setTaskSearch,
    searchActive,
    filteredTasks,
    filteredGrouped,
  };
}
