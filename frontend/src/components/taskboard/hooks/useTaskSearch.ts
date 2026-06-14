import { useMemo, useState } from 'react';
import { type Task } from '../../../api';
import { groupTasksByStatus } from './useTaskBoardState';

function taskContainsSearchText(task: Task, searchText: string): boolean {
  const haystack = `${task.title}\n${task.description ?? ''}`.toLowerCase();
  return haystack.includes(searchText);
}

// Owns the case-insensitive task search box state and derives the filtered
// task list + status grouping. `searchActive` gates lane "run all" actions so
// they can't fire against a partial view.
export function useTaskSearch(tasks: Task[]) {
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
    () => groupTasksByStatus(filteredTasks),
    [filteredTasks],
  );

  return {
    taskSearch,
    setTaskSearch,
    searchActive,
    filteredTasks,
    filteredGrouped,
  };
}
