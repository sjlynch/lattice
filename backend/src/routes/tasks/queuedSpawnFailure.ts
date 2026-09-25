// Queued-spawn attempt counting + failure handling: the shared thunk body run
// by both queued task-spawns, plus the crash-safe attempt accounting and the
// terminal-failure reporting it leans on.
//
// The crash-safe retry semantics live here: an attempt is counted disk-first
// BEFORE the spawn, a CAP re-queue undoes that bump (it isn't a real attempt),
// and any other failure clears the run-queue state + emits `task-spawn-failed`.

import { type Task } from '../../tasks.js';
import { isSpawnDeferral, isSpawnDiskSpaceError } from '../../spawnQueue.js';
import {
  notifyTaskSpawned,
  notifyTaskSpawnFailed,
} from '../../taskSpawnEvents.js';
import {
  CLEARED_RUN_QUEUE_STATE,
  defaultFailureDeps,
  isTaskStartWithdrawn,
  type SpawnFailureDeps,
} from './queuedSpawnAdmission.js';

// The minimal shape a spawn function returns; both StartTaskByIdResult and
// ResumeTaskByIdResult satisfy it. `serverId` is set only when a pty was
// actually created (so the terminal can be delivered to the UI).
export type SpawnThunkResult = {
  task: Task;
  worktreePath: string;
  command: string;
  serverId?: string;
  terminalId?: string;
};

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

// Tell the card why a queued run isn't starting. Written once per waiting
// episode (the message embeds live byte counts, and a deferred run retries
// every 30 s — rewriting it each time would churn the task store + WS).
async function noteWaitingForDisk(
  taskId: string,
  reason: string,
  deps: SpawnFailureDeps,
): Promise<void> {
  const task = await deps.getTask(taskId).catch(() => undefined);
  if (!task || task.runWaitingForDisk) return;
  try {
    await deps.updateTask(taskId, { runWaitingForDisk: reason });
  } catch (err) {
    console.error(`[task-run] failed to record disk wait for ${taskId}:`, err);
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
        terminalId: result.terminalId,
      });
    }
  } catch (err) {
    // A CAP or disk-space deferral is re-queued and retried — undo the attempt
    // bump (a run) and leave all other state alone. A start withdrawn by the
    // user (run cancelled / task re-laned mid-start) is their own doing: no
    // toast, and no state change — a cancel already cleared the queue state
    // and a re-run may have set it again. Any other failure is terminal:
    // surface it to the UI (and, for a run, clear the queue state).
    if (isTaskStartWithdrawn(err)) {
      console.log(`[task-run] ${err.message} — not started`);
    } else if (isSpawnDeferral(err)) {
      if (kind === 'run') await undoRunAttempt(taskId, deps);
      if (kind === 'run' && isSpawnDiskSpaceError(err)) await noteWaitingForDisk(taskId, err.message, deps);
    } else {
      await reportSpawnFailure(taskId, kind, err, deps);
    }
    throw err;
  }
}
