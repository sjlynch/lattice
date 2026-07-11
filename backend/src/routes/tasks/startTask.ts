// Shared "start an Open task" helper.
//
// Originally inlined in routes/tasks/runRoute.ts. Extracted so the workflow
// Start control step can drive the same code path the HTTP /run route uses
// (setupTaskWorktree → pre-spawn pty → flip to in_progress) without going
// through an HTTP hop or duplicating the logic.

import { getTask, listTasks, updateTask, type Task } from '../../tasks.js';
import { setupTaskWorktree } from '../../worktree.js';
import { SpawnCapacityError } from '../../spawnQueue.js';
import { normalizeAgentHarness, type AgentHarness } from '../../harnesses.js';
import { normalizePiModel, resolvePiModel } from '../../piModels.js';
import { isCodexYoloEnabled } from '../../userSettings.js';
import { selectHarnessCommand } from './harnessFactory.js';
import { assignColorSlot } from './colorSlot.js';

// A task can be started from scratch (fresh worktree + agent) when it is
// Open, or In Progress with no worktree on record — the latter happens when a
// task is dragged into the In Progress lane manually without ever running. In
// both cases there is no existing worktree, so setupTaskWorktree creates one.
export function isFreshlyRunnable(task: Task): boolean {
  if (task.status === 'open') return true;
  return task.status === 'in_progress' && !task.worktreePath;
}

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
  // Explicit Pi model from the run request body. Falls back to the per-project
  // default (UserSettings.piModel) when absent. Ignored unless harness is `pi`.
  requestedPiModel?: unknown;
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
  if (!isFreshlyRunnable(task)) {
    throw new Error(
      `task ${taskId} is "${task.status}" with a worktree, expected a runnable task`,
    );
  }

  // Resolve the Pi model only for a Pi run: explicit request body wins, else
  // the per-project default. Avoids a settings read for Claude/Codex tasks.
  const harness = normalizeAgentHarness(options.requestedHarness);
  const piModel =
    harness === 'pi'
      ? normalizePiModel(options.requestedPiModel) ??
        (await resolvePiModel(task.projectPath))
      : undefined;
  // Resolve the Codex `--yolo` toggle only for a Codex run (default ON).
  const codexYolo =
    harness === 'codex' ? await isCodexYoloEnabled(task.projectPath) : undefined;
  const selectedHarness = selectHarnessCommand(task, {
    requestedHarness: options.requestedHarness,
    mode: 'run',
    piModel,
    codexYolo,
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
  // Assign a stable palette slot once. Keep any existing index (a re-run of
  // a task that already has one — e.g. a CAP-rejected first pass — must not
  // jump colors). Computed against the live task list so concurrent spawns
  // land on distinct slots.
  const colorIndex =
    typeof task.colorIndex === 'number'
      ? task.colorIndex
      : assignColorSlot(await listTasks(task.projectPath), task.id);
  const updated = await updateTask(task.id, {
    status: 'in_progress',
    worktreePath: result.worktreePath,
    branch: result.branch,
    startedAt: Date.now(),
    harness: selectedHarness.harness,
    // Persist the model used so a resume re-spawns with the same one.
    piModel: selectedHarness.harness === 'pi' ? piModel : undefined,
    colorIndex,
    // The run finally spawned — drop the queued badge, the persisted execution
    // policy, and the attempt counter so a later re-run isn't gated by boot
    // recovery's retry ceiling.
    runQueued: undefined,
    runQueuedAt: undefined,
    runQueuedHarness: undefined,
    runQueuedPiModel: undefined,
    runFailureCount: undefined,
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
