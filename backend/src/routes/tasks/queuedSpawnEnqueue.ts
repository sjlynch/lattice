// Enqueue wrappers for task run / resume (plus cancellation). The HTTP /run and
// /resume routes call these instead of spawning directly. Each builds a thunk
// doing the FULL spawn (worktree setup + pty) and hands it to the spawn queue,
// which runs it now if there is concurrency headroom or defers it otherwise. The
// terminal is delivered to the frontend via the `task-spawned` WS event emitted
// from inside the thunk on success; a non-CAP failure emits `task-spawn-failed`
// instead so the UI can toast it.

import { getTask, updateTask } from '../../tasks.js';
import { cancelSpawn, enqueueSpawn } from '../../spawnQueue.js';
import { isAgentHarness } from '../../harnesses.js';
import { normalizePiModel } from '../../piModels.js';
import { startTaskById } from './startTask.js';
import { resumeTaskById } from './resumeTask.js';
import {
  CLEARED_RUN_QUEUE_STATE,
  taskResumeDedupeKey,
  taskRunDedupeKey,
  type EnqueueTaskResult,
} from './queuedSpawnAdmission.js';
import { runSpawnThunk } from './queuedSpawnFailure.js';

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
