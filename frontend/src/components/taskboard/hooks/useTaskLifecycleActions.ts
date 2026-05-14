import { useCallback } from 'react';
import {
  resumeTask as apiResumeTask,
  runTask as apiRunTask,
  type Task,
} from '../../../api';
import type { TerminalSpec } from '../../../TerminalsContext';
import { shortLabel } from '../lanes';
import type { ResolvedHarness } from './useHarnessSelector';

type AddTerminal = (spec: Omit<TerminalSpec, 'id'>, focus?: boolean) => string;

type UseTaskLifecycleActionsArgs = {
  tasks: Task[];
  addTerminal: AddTerminal;
  pickInterleaveHarness: () => ResolvedHarness;
  showError: (message: string) => void;
};

// Task lifecycle: run/resume a single task and the lane-level "run all"
// variants. Each action spawns the worktree-agent terminal via addTerminal.
export function useTaskLifecycleActions({
  tasks,
  addTerminal,
  pickInterleaveHarness,
  showError,
}: UseTaskLifecycleActionsArgs) {
  const runTask = useCallback(
    async (task: Task) => {
      try {
        const res = await apiRunTask(task.id, pickInterleaveHarness());
        addTerminal({
          label: shortLabel(task.title),
          cwd: res.worktreePath,
          initialCommand: res.command,
          taskId: task.id,
          projectPath: task.projectPath,
          serverId: res.serverId,
        }, false);
      } catch (err) {
        showError(`Run failed: ${(err as Error).message}`);
      }
    },
    [addTerminal, pickInterleaveHarness, showError],
  );

  const runAllOpen = useCallback(async () => {
    const openTasks = tasks
      .filter((task) => task.status === 'open')
      .sort((a, b) => a.createdAt - b.createdAt);
    for (const task of openTasks) {
      // sequentially to avoid hammering git
      // eslint-disable-next-line no-await-in-loop
      await runTask(task);
    }
  }, [runTask, tasks]);

  const resumeTaskAction = useCallback(
    async (task: Task) => {
      try {
        const res = await apiResumeTask(task.id, pickInterleaveHarness());
        addTerminal({
          label: shortLabel(task.title),
          cwd: res.worktreePath,
          initialCommand: res.command,
          taskId: task.id,
          projectPath: task.projectPath,
          serverId: res.serverId,
        }, false);
      } catch (err) {
        showError(`Resume failed: ${(err as Error).message}`);
      }
    },
    [addTerminal, pickInterleaveHarness, showError],
  );

  const resumeAllInProgress = useCallback(async () => {
    const list = tasks
      .filter((task) => task.status === 'in_progress' && !!task.worktreePath)
      .sort((a, b) => a.createdAt - b.createdAt);
    for (const task of list) {
      // eslint-disable-next-line no-await-in-loop
      await resumeTaskAction(task);
    }
  }, [resumeTaskAction, tasks]);

  return { runTask, runAllOpen, resumeTaskAction, resumeAllInProgress };
}
