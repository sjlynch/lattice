// Shared "start an Open task" helper.
//
// Originally inlined in routes/tasks/runRoute.ts. Extracted so the workflow
// Start control step can drive the same code path the HTTP /run route uses
// (setupTaskWorktree → flip to in_progress → pre-spawn pty) without going
// through an HTTP hop or duplicating the logic.

import { getTask, updateTask, type Task } from '../../tasks.js';
import { setupTaskWorktree } from '../../worktree.js';
import type { AgentHarness } from '../../harnesses.js';
import { selectHarnessCommand } from './harnessFactory.js';

export type StartTaskByIdResult = {
  task: Task;
  worktreePath: string;
  branch: string;
  taskFile: string;
  command: string;
  serverId?: string;
};

// Run an Open task: set up the worktree, flip status to in_progress, and
// pre-spawn the harness pty. Returns the spawn info so callers can either
// surface it (HTTP route → UI terminal) or discard it (control step →
// terminal is pre-warmed for when the user clicks into the task card).
//
// Throws if the task is missing or not in 'open' status — callers that need
// HTTP-style 400/404 responses should handle these cases themselves.
export async function startTaskById(
  taskId: string,
  backendOrigin: string,
  options: { requestedHarness?: unknown } = {},
): Promise<StartTaskByIdResult> {
  const task = await getTask(taskId);
  if (!task) throw new Error(`task ${taskId} not found`);
  if (task.status !== 'open') {
    throw new Error(`task ${taskId} is "${task.status}", expected "open"`);
  }

  const selectedHarness = selectHarnessCommand(task, {
    requestedHarness: options.requestedHarness,
    mode: 'run',
  });
  const result = await setupTaskWorktree(
    task.projectPath,
    task,
    backendOrigin,
    selectedHarness.harness,
  );
  const updated = await updateTask(task.id, {
    status: 'in_progress',
    worktreePath: result.worktreePath,
    branch: result.branch,
    startedAt: Date.now(),
  });
  const { command, serverId } = await selectedHarness.createSession({
    taskFile: result.taskFile,
    cwd: result.worktreePath,
  });

  return {
    task: updated ?? task,
    worktreePath: result.worktreePath,
    branch: result.branch,
    taskFile: result.taskFile,
    command,
    serverId,
  };
}

// Convenience for callers that already have a harness string (e.g. workflow
// runs that resolved the override at run start). Just a typed alias around
// the option above.
export async function startTaskByIdWithHarness(
  taskId: string,
  backendOrigin: string,
  harness: AgentHarness,
): Promise<StartTaskByIdResult> {
  return startTaskById(taskId, backendOrigin, { requestedHarness: harness });
}
