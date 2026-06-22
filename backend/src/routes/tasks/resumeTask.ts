// Shared "resume an in-progress task" helper.
//
// Extracted from routes/tasks/resumeRoute.ts so the spawn queue can drive
// the same code path the HTTP /resume route uses. Re-spawns the harness pty
// in the task's existing worktree with a "continue what's been started"
// prompt.

import path from 'node:path';
import { getTask, type Task } from '../../tasks.js';
import { worktreeExists } from '../../worktree.js';
import { SpawnCapacityError } from '../../spawnQueue.js';
import { normalizeAgentHarness } from '../../harnesses.js';
import { normalizePiModel, resolvePiModel } from '../../piModels.js';
import { selectHarnessCommand } from './harnessFactory.js';

export type ResumeTaskByIdResult = {
  task: Task;
  worktreePath: string;
  command: string;
  serverId?: string;
};

export type ResumeTaskByIdOptions = {
  // See StartTaskByIdOptions.throwOnCapacity — same contract.
  throwOnCapacity?: boolean;
};

// Re-validates the task (status, worktree on disk) and re-spawns the pty.
// Re-validation matters because a queued resume's thunk can run minutes
// after the route accepted it. Throws on any precondition failure.
export async function resumeTaskById(
  taskId: string,
  requestedHarness: unknown,
  options: ResumeTaskByIdOptions = {},
  requestedPiModel?: unknown,
): Promise<ResumeTaskByIdResult> {
  const task = await getTask(taskId);
  if (!task) throw new Error(`task ${taskId} not found`);
  if (task.status !== 'in_progress') {
    throw new Error(`task ${taskId} is "${task.status}", expected "in_progress"`);
  }
  if (!task.worktreePath) {
    throw new Error(`task ${taskId} has no worktree path on record`);
  }
  if (!(await worktreeExists(task.worktreePath))) {
    throw new Error(
      `Worktree directory not found at ${task.worktreePath}. ` +
        `The worktree may have been removed manually.`,
    );
  }

  const taskFile = path.join(task.worktreePath, 'LATTICE_TASK.md');
  // Pi model for the resume: explicit request wins, else the model the task
  // originally ran with, else the per-project default.
  const harness = normalizeAgentHarness(requestedHarness);
  const piModel =
    harness === 'pi'
      ? normalizePiModel(requestedPiModel) ??
        normalizePiModel(task.piModel) ??
        (await resolvePiModel(task.projectPath))
      : undefined;
  const selectedHarness = selectHarnessCommand(task, {
    requestedHarness,
    mode: 'resume',
    piModel,
  });
  const spawn = await selectedHarness.createSession({
    taskFile,
    cwd: task.worktreePath,
  });
  if (spawn.capHit && options.throwOnCapacity) {
    throw new SpawnCapacityError(
      `task ${taskId}: no terminal slot (terminal-server hard cap)`,
    );
  }

  return {
    task,
    worktreePath: task.worktreePath,
    command: spawn.command,
    serverId: spawn.serverId,
  };
}
