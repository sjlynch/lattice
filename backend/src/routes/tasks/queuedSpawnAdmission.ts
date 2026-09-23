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
