// Spawn-queue wrappers for task run / resume.
//
// The HTTP /run and /resume routes call these instead of spawning directly.
// Each builds a thunk doing the FULL spawn (worktree setup + pty) and hands
// it to the spawn queue, which runs it now if there is concurrency headroom
// or defers it otherwise. The terminal is delivered to the frontend via the
// `task-spawned` WS event emitted from inside the thunk on success; a non-CAP
// failure emits `task-spawn-failed` instead so the UI can toast it.

import { getTask, updateTask, type Task } from '../../tasks.js';
import {
  cancelSpawn,
  enqueueSpawn,
  isSpawnCapacityError,
} from '../../spawnQueue.js';
import {
  notifyTaskSpawned,
  notifyTaskSpawnFailed,
} from '../../taskSpawnEvents.js';
import { startTaskById } from './startTask.js';
import { resumeTaskById } from './resumeTask.js';

export function taskRunDedupeKey(taskId: string): string {
  return `task-run:${taskId}`;
}

export function taskResumeDedupeKey(taskId: string): string {
  return `task-resume:${taskId}`;
}

export type EnqueueTaskResult = { queued: boolean };

// The minimal shape a spawn function returns; both StartTaskByIdResult and
// ResumeTaskByIdResult satisfy it. `serverId` is set only when a pty was
// actually created (so the terminal can be delivered to the UI).
type SpawnThunkResult = {
  task: Task;
  worktreePath: string;
  command: string;
  serverId?: string;
};

// I/O the failure path touches, injectable so the thunk's failure handling can
// be unit-tested without the real tasks store. Production wires the real ones.
export type SpawnFailureDeps = {
  getTask: typeof getTask;
  updateTask: typeof updateTask;
};

const defaultFailureDeps: SpawnFailureDeps = { getTask, updateTask };

// Handle a queued spawn's terminal (non-CAP) failure: for a run, clear the
// run-queue flag and bump the deterministic-failure counter so boot recovery
// eventually stops re-enqueuing it; for both run and resume, emit a
// `task-spawn-failed` WS event so the UI can toast the failure. A CAP failure
// is NOT terminal (the queue re-queues it) — callers must skip this for those.
export async function reportSpawnFailure(
  taskId: string,
  kind: 'run' | 'resume',
  err: unknown,
  deps: SpawnFailureDeps = defaultFailureDeps,
): Promise<void> {
  const task = await deps.getTask(taskId).catch(() => undefined);
  const reason = err instanceof Error ? err.message : String(err);

  // A run persists `runQueued`; clear it so the card stops showing the badge,
  // and bump the failure counter (the boot-recovery retry ceiling). Resume is
  // transient (no persisted flag), so there is nothing to reset for it.
  if (kind === 'run') {
    try {
      await deps.updateTask(taskId, {
        runQueued: undefined,
        runQueuedAt: undefined,
        runFailureCount: (task?.runFailureCount ?? 0) + 1,
      });
    } catch (clearErr) {
      // Don't let a failed flag-clear mask the original failure or surface as
      // an unhandled rejection — log it. The original error still propagates
      // out of the thunk (the queue logs that too).
      console.error(
        `[task-run] failed to clear runQueued for ${taskId} after a spawn failure:`,
        clearErr,
      );
    }
  }

  notifyTaskSpawnFailed({
    projectPath: task?.projectPath ?? '',
    taskId,
    title: task?.title ?? '',
    kind,
    reason,
  });
}

// The body of a queued task-spawn thunk, shared by run and resume: run the
// spawn, deliver the pty over `task-spawned` on success, and on a non-CAP
// failure clear run-queue state + emit `task-spawn-failed`. A CAP failure is
// re-thrown untouched so the spawn queue re-queues it. Always re-throws so the
// queue's accounting still settles `done` as a rejection. Exported so the
// failure handling can be exercised directly (force `spawn` to throw).
export async function runSpawnThunk(
  taskId: string,
  kind: 'run' | 'resume',
  spawn: () => Promise<SpawnThunkResult>,
  deps: SpawnFailureDeps = defaultFailureDeps,
): Promise<void> {
  try {
    const result = await spawn();
    if (result.serverId) {
      notifyTaskSpawned({
        projectPath: result.task.projectPath,
        taskId,
        title: result.task.title,
        command: result.command,
        worktreePath: result.worktreePath,
        serverId: result.serverId,
      });
    }
  } catch (err) {
    // A CAP error is re-queued and retried — leave all state alone. Any other
    // failure is terminal: surface it to the UI (and, for a run, reset the
    // queue flag + bump the retry counter).
    if (!isSpawnCapacityError(err)) {
      await reportSpawnFailure(taskId, kind, err, deps);
    }
    throw err;
  }
}

// Enqueue an Open task's run. Persists `runQueued` so the card shows a badge
// and boot recovery can re-enqueue if the backend restarts while it waits.
export async function enqueueTaskRun(
  taskId: string,
  backendOrigin: string,
  requestedHarness: unknown,
  requestedPiModel?: unknown,
): Promise<EnqueueTaskResult> {
  const task = await getTask(taskId);
  if (task && !task.runQueued) {
    await updateTask(taskId, { runQueued: true, runQueuedAt: Date.now() });
  }

  const { queued, done } = enqueueSpawn<void>({
    kind: 'task-run',
    priority: 'batch',
    dedupeKey: taskRunDedupeKey(taskId),
    thunk: () =>
      runSpawnThunk(taskId, 'run', () =>
        startTaskById(taskId, backendOrigin, {
          requestedHarness,
          requestedPiModel,
          throwOnCapacity: true,
        }),
      ),
  });
  // The HTTP route does not await `done`; swallow its rejection so a thunk
  // failure is not an unhandled promise rejection (the thunk emits the
  // task-spawn-failed event, and the queue logs the error).
  done.catch(() => {});
  return { queued };
}

// Enqueue a resume of an in-progress task. Resume is transient — not
// persisted across a restart (unlike a run's `runQueued`): if the backend
// restarts while a resume waits, the user simply clicks resume again.
export async function enqueueTaskResume(
  taskId: string,
  requestedHarness: unknown,
  requestedPiModel?: unknown,
): Promise<EnqueueTaskResult> {
  const { queued, done } = enqueueSpawn<void>({
    kind: 'task-resume',
    priority: 'batch',
    dedupeKey: taskResumeDedupeKey(taskId),
    thunk: () =>
      runSpawnThunk(taskId, 'resume', () =>
        resumeTaskById(
          taskId,
          requestedHarness,
          { throwOnCapacity: true },
          requestedPiModel,
        ),
      ),
  });
  done.catch(() => {});
  return { queued };
}

// Cancel any still-pending run/resume spawn for a task — called when the
// task is deleted. An already in-flight spawn is left to complete; the
// normal task-delete worktree cleanup handles it.
export function cancelQueuedTaskSpawns(taskId: string): void {
  cancelSpawn(taskRunDedupeKey(taskId));
  cancelSpawn(taskResumeDedupeKey(taskId));
}

// Remove a task's queued run: drop the still-pending spawn (if it has not
// been admitted yet) and clear the persisted runQueued flag so the card
// stops showing the badge and boot recovery won't re-enqueue it. Also clears
// the failure counter so an explicit re-run starts from a clean slate.
// Best-effort — if the run was already admitted the spawn proceeds and the
// thunk clears the flag itself on completion.
export async function dequeueTaskRun(taskId: string): Promise<void> {
  cancelSpawn(taskRunDedupeKey(taskId));
  await updateTask(taskId, {
    runQueued: undefined,
    runQueuedAt: undefined,
    runFailureCount: undefined,
  });
}
