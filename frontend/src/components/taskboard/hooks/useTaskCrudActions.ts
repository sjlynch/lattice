import { useCallback } from 'react';
import {
  createTask as apiCreateTask,
  deleteTask as apiDeleteTask,
  updateTask as apiUpdateTask,
  type TaskStatus,
} from '../../../api';
import { useGitSetup } from '../../gitSetup/GitSetupProvider';

type UseTaskCrudActionsArgs = {
  activeFolder: string;
  showError: (message: string) => void;
};

// Task CRUD: add/edit/delete plus the plain status-change move. Pulled
// out of useTaskActions so reorder/lifecycle/merge concerns can compose
// over a minimal CRUD surface.
export function useTaskCrudActions({ activeFolder, showError }: UseTaskCrudActionsArgs) {
  const { ensureGitRepo } = useGitSetup();

  const addTask = useCallback(
    async (status: TaskStatus, title: string, description?: string): Promise<boolean> => {
      if (!activeFolder || !title.trim()) return false;
      // The backend rejects task *creation* in a non-git project (a 400 from
      // routes/tasks/projectValidation.ts), so offer setup before firing the
      // doomed POST. On success we fall straight through to the create the user
      // already typed — returning false here only on a genuine decline, which
      // keeps the new-task overlay open with their text intact.
      if (!(await ensureGitRepo(activeFolder))) return false;
      let created: { id: string };
      try {
        created = await apiCreateTask(activeFolder, title, description);
      } catch (err) {
        showError((err as Error).message);
        return false;
      }
      // If we're adding to a non-open lane, immediately update its status.
      // The task already exists at this point, so a failed PATCH is reported
      // but still counts as "created" (true) — returning false would keep the
      // overlay open and a retry would create a duplicate in Open.
      if (status !== 'open') {
        try {
          await apiUpdateTask(created.id, { status });
        } catch (err) {
          showError(
            `Task created in Open, but moving it to ${status} failed: ${(err as Error).message}`,
          );
        }
      }
      return true;
    },
    [activeFolder, ensureGitRepo, showError],
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

  // Resolves true only when the backend PATCH succeeds. The detail overlay
  // awaits this and stays open (preserving the in-progress edits) on false, so
  // a failed save is observable instead of silently dismissing the modal as if
  // it had landed.
  const editTask = useCallback(
    async (
      id: string,
      updates: { title?: string; description?: string },
    ): Promise<boolean> => {
      try {
        await apiUpdateTask(id, updates);
        return true;
      } catch (err) {
        showError((err as Error).message);
        return false;
      }
    },
    [showError],
  );

  const deleteTask = useCallback(
    async (id: string): Promise<boolean> => {
      try {
        await apiDeleteTask(id);
        return true;
      } catch (err) {
        showError((err as Error).message);
        return false;
      }
    },
    [showError],
  );

  return { addTask, moveTask, editTask, deleteTask };
}
