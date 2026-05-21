// Spawn-queue wrappers for task run / resume.
//
// The HTTP /run and /resume routes call these instead of spawning directly.
// Each builds a thunk doing the FULL spawn (worktree setup + pty) and hands
// it to the spawn queue, which runs it now if there is concurrency headroom
// or defers it otherwise. The terminal is delivered to the frontend via the
// `task-spawned` WS event emitted from inside the thunk on success.

import { getTask, updateTask } from '../../tasks.js';
import {
  cancelSpawn,
  enqueueSpawn,
  isSpawnCapacityError,
} from '../../spawnQueue.js';
import { notifyTaskSpawned } from '../../taskSpawnEvents.js';
import { startTaskById } from './startTask.js';
import { resumeTaskById } from './resumeTask.js';

export function taskRunDedupeKey(taskId: string): string {
  return `task-run:${taskId}`;
}

export function taskResumeDedupeKey(taskId: string): string {
  return `task-resume:${taskId}`;
}

export type EnqueueTaskResult = { queued: boolean };

// Enqueue an Open task's run. Persists `runQueued` so the card shows a badge
// and boot recovery can re-enqueue if the backend restarts while it waits.
export async function enqueueTaskRun(
  taskId: string,
  backendOrigin: string,
  requestedHarness: unknown,
): Promise<EnqueueTaskResult> {
  const task = await getTask(taskId);
  if (task && !task.runQueued) {
    await updateTask(taskId, { runQueued: true, runQueuedAt: Date.now() });
  }

  const { queued, done } = enqueueSpawn<void>({
    kind: 'task-run',
    priority: 'batch',
    dedupeKey: taskRunDedupeKey(taskId),
    thunk: async () => {
      try {
        const result = await startTaskById(taskId, backendOrigin, {
          requestedHarness,
          throwOnCapacity: true,
        });
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
        // A CAP error is re-queued and retried — keep `runQueued` set. Any
        // other failure is terminal: clear the flag so boot recovery does
        // not retry it forever, and leave the task in whatever state it is.
        if (!isSpawnCapacityError(err)) {
          await updateTask(taskId, {
            runQueued: undefined,
            runQueuedAt: undefined,
          }).catch(() => {});
        }
        throw err;
      }
    },
  });
  // The HTTP route does not await `done`; swallow its rejection so a thunk
  // failure is not an unhandled promise rejection (the thunk + queue log it).
  done.catch(() => {});
  return { queued };
}

// Enqueue a resume of an in-progress task. Resume is transient — not
// persisted across a restart (unlike a run's `runQueued`): if the backend
// restarts while a resume waits, the user simply clicks resume again.
export async function enqueueTaskResume(
  taskId: string,
  requestedHarness: unknown,
): Promise<EnqueueTaskResult> {
  const { queued, done } = enqueueSpawn<void>({
    kind: 'task-resume',
    priority: 'batch',
    dedupeKey: taskResumeDedupeKey(taskId),
    thunk: async () => {
      const result = await resumeTaskById(taskId, requestedHarness, {
        throwOnCapacity: true,
      });
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
    },
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
// stops showing the badge and boot recovery won't re-enqueue it. Best-effort
// — if the run was already admitted the spawn proceeds and the thunk clears
// the flag itself on completion.
export async function dequeueTaskRun(taskId: string): Promise<void> {
  cancelSpawn(taskRunDedupeKey(taskId));
  await updateTask(taskId, { runQueued: undefined, runQueuedAt: undefined });
}
