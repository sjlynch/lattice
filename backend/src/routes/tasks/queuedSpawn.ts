// Spawn-queue wrappers for task run / resume.
//
// The HTTP /run and /resume routes call these instead of spawning directly.
// Each builds a thunk doing the FULL spawn (worktree setup + pty) and hands
// it to the spawn queue, which runs it now if there is concurrency headroom
// or defers it otherwise. The terminal is delivered to the frontend via the
// `task-spawned` WS event emitted from inside the thunk on success; a non-CAP
// failure emits `task-spawn-failed` instead so the UI can toast it.

import {
  getTask,
  updateTask,
  updateTaskCrashSafe,
  type Task,
} from '../../tasks.js';
import {
  cancelSpawn,
  enqueueSpawn,
  isSpawnCapacityError,
} from '../../spawnQueue.js';
import {
  notifyTaskSpawned,
  notifyTaskSpawnFailed,
} from '../../taskSpawnEvents.js';
import { isAgentHarness } from '../../harnesses.js';
import { normalizePiModel } from '../../piModels.js';
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
// `updateTaskCrashSafe` is used for the at-admission attempt bump so the count
// is on disk before the (possibly process-crashing) spawn runs.
export type SpawnFailureDeps = {
  getTask: typeof getTask;
  updateTask: typeof updateTask;
  updateTaskCrashSafe: typeof updateTaskCrashSafe;
};

const defaultFailureDeps: SpawnFailureDeps = {
  getTask,
  updateTask,
  updateTaskCrashSafe,
};

// The run-queue state to clear whenever a queued run is resolved (failed /
// cancelled / given up): the badge flag, its timestamp, the persisted
// harness/model execution policy, and the attempt counter — so the card drops
// the "Queued" pill and a later manual re-run starts from a clean slate.
const CLEARED_RUN_QUEUE_STATE = {
  runQueued: undefined,
  runQueuedAt: undefined,
  runQueuedHarness: undefined,
  runQueuedPiModel: undefined,
  runFailureCount: undefined,
} as const;

// Count this run attempt BEFORE the spawn, persisted crash-safely. A run can
// deterministically crash the whole backend process during worktree setup / pty
// spawn; if attempts were only counted in a catch, such a crash would never
// increment the counter and boot recovery would re-enqueue it forever. Writing
// the bump disk-first (updateTaskCrashSafe) makes the ceiling enforceable across
// restarts. A CAP re-queue undoes this (see undoRunAttempt) — it isn't a real
// attempt, and by the time a CAP rejection is seen the crash-prone setup has
// already succeeded.
async function bumpRunAttempt(
  taskId: string,
  deps: SpawnFailureDeps,
): Promise<void> {
  const task = await deps.getTask(taskId).catch(() => undefined);
  try {
    await deps.updateTaskCrashSafe(taskId, {
      runFailureCount: (task?.runFailureCount ?? 0) + 1,
    });
  } catch (err) {
    console.error(
      `[task-run] failed to record run attempt for ${taskId}:`,
      err,
    );
  }
}

// Undo a pre-spawn attempt bump after a CAP re-queue: a hard-cap rejection is
// retried by the queue and must not burn the retry budget. CAP rejections never
// crash the process, so this in-process undo always runs.
async function undoRunAttempt(
  taskId: string,
  deps: SpawnFailureDeps,
): Promise<void> {
  const task = await deps.getTask(taskId).catch(() => undefined);
  const next = (task?.runFailureCount ?? 0) - 1;
  try {
    await deps.updateTask(taskId, {
      runFailureCount: next > 0 ? next : undefined,
    });
  } catch (err) {
    console.error(
      `[task-run] failed to undo run attempt for ${taskId}:`,
      err,
    );
  }
}

// Handle a queued spawn's terminal (non-CAP) failure: for a run, clear the
// run-queue state (badge flag + harness/model policy + attempt counter) so the
// card stops showing the badge and a re-run starts fresh; for both run and
// resume, emit a `task-spawn-failed` WS event so the UI can toast the failure.
// The attempt counter was already bumped at admission, so nothing is counted
// here. A CAP failure is NOT terminal (the queue re-queues it) — callers must
// skip this for those.
export async function reportSpawnFailure(
  taskId: string,
  kind: 'run' | 'resume',
  err: unknown,
  deps: SpawnFailureDeps = defaultFailureDeps,
): Promise<void> {
  const task = await deps.getTask(taskId).catch(() => undefined);
  const reason = err instanceof Error ? err.message : String(err);

  // A run persists `runQueued` + the execution policy; clear them. Resume is
  // transient (no persisted flag), so there is nothing to reset for it.
  if (kind === 'run') {
    try {
      await deps.updateTask(taskId, { ...CLEARED_RUN_QUEUE_STATE });
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

// The body of a queued task-spawn thunk, shared by run and resume: count the
// run attempt crash-safely up front, run the spawn, deliver the pty over
// `task-spawned` on success, and on a non-CAP failure clear run-queue state +
// emit `task-spawn-failed`. A CAP failure undoes the attempt bump and is
// re-thrown untouched so the spawn queue re-queues it. Always re-throws so the
// queue's accounting still settles `done` as a rejection. Exported so the
// admission counting + failure handling can be exercised directly (force
// `spawn` to throw).
export async function runSpawnThunk(
  taskId: string,
  kind: 'run' | 'resume',
  spawn: () => Promise<SpawnThunkResult>,
  deps: SpawnFailureDeps = defaultFailureDeps,
): Promise<void> {
  // Only a run persists state across restarts (and is boot-recovered), so only
  // a run's attempts are counted. Resume is transient.
  if (kind === 'run') {
    await bumpRunAttempt(taskId, deps);
  }
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
    // A CAP error is re-queued and retried — undo the attempt bump (a run) and
    // leave all other state alone. Any other failure is terminal: surface it
    // to the UI (and, for a run, clear the queue state).
    if (isSpawnCapacityError(err)) {
      if (kind === 'run') await undoRunAttempt(taskId, deps);
    } else {
      await reportSpawnFailure(taskId, kind, err, deps);
    }
    throw err;
  }
}

// Enqueue an Open task's run. Persists `runQueued` plus the requested harness/
// Pi model so the card shows a badge and boot recovery can re-enqueue — with
// the ORIGINAL harness/model — if the backend restarts while it waits.
export async function enqueueTaskRun(
  taskId: string,
  backendOrigin: string,
  requestedHarness: unknown,
  requestedPiModel?: unknown,
): Promise<EnqueueTaskResult> {
  const task = await getTask(taskId);
  if (task && !task.runQueued) {
    // Persist the execution policy only when explicitly requested: an absent
    // harness means "resolve the project/global default at spawn", which must
    // stay deferred (the default may differ by the time boot recovery runs).
    await updateTask(taskId, {
      runQueued: true,
      runQueuedAt: Date.now(),
      runQueuedHarness: isAgentHarness(requestedHarness)
        ? requestedHarness
        : undefined,
      runQueuedPiModel: normalizePiModel(requestedPiModel),
    });
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
  await updateTask(taskId, { ...CLEARED_RUN_QUEUE_STATE });
}
