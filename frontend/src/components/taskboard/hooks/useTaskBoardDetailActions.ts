import { useCallback, useMemo, useState } from 'react';
import type { Task, TaskStatus } from '../../../api';
import { useSyncedViewedTask } from './useSyncedViewedTask';

type DetailActionArgs = {
  tasks: Task[];
  addTask: (
    status: TaskStatus,
    title: string,
    description?: string,
  ) => Promise<boolean>;
  moveTask: (id: string, status: TaskStatus) => void;
  deleteTask: (id: string) => Promise<boolean>;
  editTask: (
    id: string,
    updates: { title?: string; description?: string },
  ) => Promise<boolean>;
  runTask: (task: Task) => void;
};

// Detail/editing surface for the launcher: the new-task overlay lane, the
// synced detail task, and callbacks that adapt task-level actions to whichever
// task the user is currently viewing. Kept separate from run orchestration so
// the controller is only cross-concern composition.
export function useTaskBoardDetailActions({
  tasks,
  addTask,
  moveTask,
  deleteTask,
  editTask,
  runTask,
}: DetailActionArgs) {
  const [addingTo, setAddingTo] = useState<TaskStatus | null>(null);
  const [viewing, setViewing] = useSyncedViewedTask(tasks);

  const submitNewTask = useCallback(
    async (title: string, desc?: string) => {
      if (!addingTo) return;
      if (await addTask(addingTo, title, desc)) setAddingTo(null);
    },
    [addTask, addingTo],
  );

  const moveViewingTask = useCallback(
    (status: TaskStatus) => {
      if (!viewing) return;
      moveTask(viewing.id, status);
    },
    [moveTask, viewing],
  );

  const deleteViewingTask = useCallback(async () => {
    if (!viewing) return;
    if (await deleteTask(viewing.id)) setViewing(null);
  }, [deleteTask, setViewing, viewing]);

  const saveViewingTask = useCallback(
    (updates: { title?: string; description?: string }) => {
      if (!viewing) return Promise.resolve(false);
      return editTask(viewing.id, updates);
    },
    [editTask, viewing],
  );

  const runViewingTask = useMemo(() => {
    if (
      !viewing ||
      (viewing.status !== 'open' &&
        !(viewing.status === 'in_progress' && !viewing.worktreePath))
    ) {
      return undefined;
    }
    return () => {
      runTask(viewing);
      setViewing(null);
    };
  }, [runTask, setViewing, viewing]);

  return {
    addingTo,
    deleteViewingTask,
    moveViewingTask,
    runViewingTask,
    saveViewingTask,
    setAddingTo,
    setViewing,
    submitNewTask,
    viewing,
  };
}
