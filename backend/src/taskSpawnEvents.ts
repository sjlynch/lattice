// Pub/sub for `task-spawned` / `task-spawn-failed` events.
//
// A queued task run has no pty at HTTP-response time, so the terminal can no
// longer be delivered in the `/run` response. Instead, when the queue admits
// a task spawn and the pty is created, the task-run thunk emits a
// `task-spawned` event here; the `/ws/tasks` endpoint fans it out so every
// browser tab watching the project lazy-mounts the terminal — mirroring the
// workflow `step-spawned` model.
//
// The flip side: a queued spawn that *fails* (non-CAP — worktree setup threw,
// terminal-server wedged, the worktree vanished between the route pre-check and
// the thunk running) also runs detached, long after the `{accepted:true}`
// response. Without a signal the user just sees the run badge appear then
// vanish (run) or nothing at all (resume). `task-spawn-failed` carries the
// failure to the same `/ws/tasks` channel so the UI can toast it.

export type TaskSpawnedEvent = {
  projectPath: string;
  taskId: string;
  title: string;
  command: string;
  worktreePath: string;
  // Always set: the thunk only emits the event when a pty was created.
  serverId: string;
};

export type TaskSpawnFailedEvent = {
  projectPath: string;
  taskId: string;
  title: string;
  // Which queued spawn failed, so the toast can say "start" vs "resume".
  kind: 'run' | 'resume';
  // Human-readable failure reason (the thrown Error's message).
  reason: string;
};

type SpawnedListener = (event: TaskSpawnedEvent) => void;
type SpawnFailedListener = (event: TaskSpawnFailedEvent) => void;

const spawnedListeners = new Set<SpawnedListener>();
const spawnFailedListeners = new Set<SpawnFailedListener>();

export function subscribeTaskSpawned(listener: SpawnedListener): () => void {
  spawnedListeners.add(listener);
  return () => spawnedListeners.delete(listener);
}

export function notifyTaskSpawned(event: TaskSpawnedEvent): void {
  for (const listener of [...spawnedListeners]) {
    try {
      listener(event);
    } catch (err) {
      console.error('[task-spawned] listener threw:', err);
    }
  }
}

export function subscribeTaskSpawnFailed(
  listener: SpawnFailedListener,
): () => void {
  spawnFailedListeners.add(listener);
  return () => spawnFailedListeners.delete(listener);
}

export function notifyTaskSpawnFailed(event: TaskSpawnFailedEvent): void {
  for (const listener of [...spawnFailedListeners]) {
    try {
      listener(event);
    } catch (err) {
      console.error('[task-spawn-failed] listener threw:', err);
    }
  }
}
