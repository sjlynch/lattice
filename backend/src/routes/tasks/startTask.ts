// Shared "start an Open task" helper.
//
// Originally inlined in routes/tasks/runRoute.ts. Extracted so the workflow
// Start control step can drive the same code path the HTTP /run route uses
// (setupTaskWorktree → pre-spawn pty → flip to in_progress) without going
// through an HTTP hop or duplicating the logic.

import { getTask, updateTask, type Task } from '../../tasks.js';
import { setupTaskWorktree } from '../../worktree.js';
import { SpawnCapacityError } from '../../spawnQueue.js';
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

export type StartTaskByIdOptions = {
  requestedHarness?: unknown;
  // When true, a terminal-server hard-cap rejection throws SpawnCapacityError
  // and the task is left 'open' (so the spawn-queue thunk is re-runnable).
  // When false/omitted, a cap rejection is swallowed: the task still flips to
  // in_progress with no pre-spawned pty (the un-queued control-step path).
  throwOnCapacity?: boolean;
};

// Run an Open task: set up the worktree, pre-spawn the harness pty, then flip
// status to in_progress. Returns the spawn info so callers can either surface
// it (HTTP route → UI terminal) or discard it (control step → terminal is
// pre-warmed for when the user clicks into the task card).
//
// The status flip happens AFTER the pty spawn so a CAP-rejected spawn (with
// throwOnCapacity) leaves the task 'open': the spawn-queue re-runs this whole
// function, and setupTaskWorktree's reconcileStaleState makes the second pass
// idempotent against the worktree the first pass already created.
//
// Throws if the task is missing or not in 'open' status — callers that need
// HTTP-style 400/404 responses should handle these cases themselves.
export async function startTaskById(
  taskId: string,
  backendOrigin: string,
  options: StartTaskByIdOptions = {},
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
  const spawn = await selectedHarness.createSession({
    taskFile: result.taskFile,
    cwd: result.worktreePath,
  });
  if (spawn.capHit && options.throwOnCapacity) {
    throw new SpawnCapacityError(
      `task ${taskId}: no terminal slot (terminal-server hard cap)`,
    );
  }
  const updated = await updateTask(task.id, {
    status: 'in_progress',
    worktreePath: result.worktreePath,
    branch: result.branch,
    startedAt: Date.now(),
    runQueued: undefined,
    runQueuedAt: undefined,
  });

  return {
    task: updated ?? task,
    worktreePath: result.worktreePath,
    branch: result.branch,
    taskFile: result.taskFile,
    command: spawn.command,
    serverId: spawn.serverId,
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
