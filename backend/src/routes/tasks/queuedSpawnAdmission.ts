// Queued-spawn admission state: the queue identity keys, the persisted
// run-queue admission policy that a queued run carries across restarts, and the
// injectable I/O the failure path touches.
//
// "Admission" here is the act of letting a task onto the spawn queue: a run
// persists `runQueued` + its harness/model so the card shows a badge and boot
// recovery can re-enqueue it; a resume is transient and persists nothing. The
// `CLEARED_RUN_QUEUE_STATE` below is the exact inverse — what to wipe when a
// queued run is resolved (failed / cancelled / given up).

import {
  getTask,
  updateTask,
  updateTaskCrashSafe,
} from '../../tasks.js';

export function taskRunDedupeKey(taskId: string): string {
  return `task-run:${taskId}`;
}

export function taskResumeDedupeKey(taskId: string): string {
  return `task-resume:${taskId}`;
}

export type EnqueueTaskResult = { queued: boolean };

// I/O the failure path touches, injectable so the thunk's failure handling can
// be unit-tested without the real tasks store. Production wires the real ones.
// `updateTaskCrashSafe` is used for the at-admission attempt bump so the count
// is on disk before the (possibly process-crashing) spawn runs.
export type SpawnFailureDeps = {
  getTask: typeof getTask;
  updateTask: typeof updateTask;
  updateTaskCrashSafe: typeof updateTaskCrashSafe;
};

export const defaultFailureDeps: SpawnFailureDeps = {
  getTask,
  updateTask,
  updateTaskCrashSafe,
};

// The run-queue state to clear whenever a queued run is resolved (failed /
// cancelled / given up): the badge flag, its timestamp, the persisted
// harness/model execution policy, and the attempt counter — so the card drops
// the "Queued" pill and a later manual re-run starts from a clean slate.
export const CLEARED_RUN_QUEUE_STATE = {
  runQueued: undefined,
  runQueuedAt: undefined,
  runQueuedHarness: undefined,
  runQueuedPiModel: undefined,
  runFailureCount: undefined,
  runWaitingForDisk: undefined,
} as const;

// Thrown by startTaskById/resumeTaskById when withdrawn while they ran: the
// queued run was cancelled (`cancel-queued-run` / delete aborted the spawn's
// signal) or the task left the runnable lanes (dragged to Backlog, …). The
// resources they own are already torn down (a resume owns only its new PTY)
// and the user's change stands. A resume also withdraws if its task was
// deleted or changed worktrees. Not a failure: runSpawnThunk neither toasts
// it nor touches the run-queue state (a re-run may already have re-queued it).
export class TaskStartWithdrawnError extends Error {
  readonly isTaskStartWithdrawn = true;
  constructor(
    taskId: string,
    readonly reason: 'cancelled' | 'relaned' | 'deleted' | 'worktree-changed',
    status?: string,
  ) {
    super(
      reason === 'deleted'
        ? `task ${taskId}: deleted while its resume was being started`
        : reason === 'worktree-changed'
        ? `task ${taskId}: worktree changed while its resume was being started`
        : reason === 'cancelled'
        ? `task ${taskId}: run was cancelled while it was being started`
        : `task ${taskId}: moved to "${status ?? 'another lane'}" while its run was being started`,
    );
    this.name = 'TaskStartWithdrawnError';
  }
}

export function isTaskStartWithdrawn(err: unknown): err is TaskStartWithdrawnError {
  return (
    err instanceof TaskStartWithdrawnError ||
    (typeof err === 'object' &&
      err !== null &&
      (err as { isTaskStartWithdrawn?: unknown }).isTaskStartWithdrawn === true)
  );
}
