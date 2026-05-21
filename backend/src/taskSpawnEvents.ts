// Pub/sub for `task-spawned` events.
//
// A queued task run has no pty at HTTP-response time, so the terminal can no
// longer be delivered in the `/run` response. Instead, when the queue admits
// a task spawn and the pty is created, the task-run thunk emits a
// `task-spawned` event here; the `/ws/tasks` endpoint fans it out so every
// browser tab watching the project lazy-mounts the terminal — mirroring the
// workflow `step-spawned` model.

export type TaskSpawnedEvent = {
  projectPath: string;
  taskId: string;
  title: string;
  command: string;
  worktreePath: string;
  // Always set: the thunk only emits the event when a pty was created.
  serverId: string;
};

type Listener = (event: TaskSpawnedEvent) => void;

const listeners = new Set<Listener>();

export function subscribeTaskSpawned(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function notifyTaskSpawned(event: TaskSpawnedEvent): void {
  for (const listener of [...listeners]) {
    try {
      listener(event);
    } catch (err) {
      console.error('[task-spawned] listener threw:', err);
    }
  }
}
