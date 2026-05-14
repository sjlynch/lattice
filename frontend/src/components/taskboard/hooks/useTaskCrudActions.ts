import { useCallback } from 'react';
import {
  createTask as apiCreateTask,
  deleteTask as apiDeleteTask,
  updateTask as apiUpdateTask,
  type TaskStatus,
} from '../../../api';

type UseTaskCrudActionsArgs = {
  activeFolder: string;
  showError: (message: string) => void;
};

// Task CRUD: add/edit/delete plus the plain status-change move. Pulled
// out of useTaskActions so reorder/lifecycle/merge concerns can compose
// over a minimal CRUD surface.
export function useTaskCrudActions({ activeFolder, showError }: UseTaskCrudActionsArgs) {
  const addTask = useCallback(
    async (status: TaskStatus, title: string, description?: string) => {
      if (!activeFolder || !title.trim()) return;
      try {
        const created = await apiCreateTask(activeFolder, title, description);
        // If we're adding to a non-open lane, immediately update its status.
        if (status !== 'open') {
          await apiUpdateTask(created.id, { status });
        }
      } catch (err) {
        showError((err as Error).message);
      }
    },
    [activeFolder, showError],
  );

  const moveTask = useCallback(
    async (id: string, status: TaskStatus) => {
      try {
        await apiUpdateTask(id, { status });
      } catch (err) {
        showError((err as Error).message);
      }
    },
    [showError],
  );

  const editTask = useCallback(
    async (id: string, updates: { title?: string; description?: string }) => {
      try {
        await apiUpdateTask(id, updates);
      } catch (err) {
        showError((err as Error).message);
      }
    },
    [showError],
  );

  const deleteTask = useCallback(
    async (id: string) => {
      try {
        await apiDeleteTask(id);
      } catch (err) {
        showError((err as Error).message);
      }
    },
    [showError],
  );

  return { addTask, moveTask, editTask, deleteTask };
}
