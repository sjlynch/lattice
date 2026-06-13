// Pub/sub for `task-activity` events.
//
// While a Claude worktree agent runs, its PreToolUse/PostToolUse hooks POST
// `/api/tasks/:id/activity` with the file it is reading or modifying. The
// route maps the worktree path back to a project-absolute path and emits one
// of these; the `/ws/tasks` endpoint fans it out so the 3D graph can draw a
// focus beam from the task's Claude node to that file node. Mirrors the
// `taskSpawnEvents.ts` model.

export type TaskActivityPhase = 'start' | 'end';

export type TaskActivityEvent = {
  projectPath: string;
  taskId: string;
  // Project-absolute path of the file the agent touched (mapped from the
  // worktree path). Matches a graph node's `path`.
  file: string;
  // 'start' = PreToolUse (tool about to run), 'end' = PostToolUse (finished).
  phase: TaskActivityPhase;
  // The tool name (Read / Edit / Write / MultiEdit / NotebookEdit).
  tool: string;
  // Backend receipt time (ms). Frontend uses it only for ordering/debug; the
  // beam TTL is driven by the frontend's own clock.
  ts: number;
};

type Listener = (event: TaskActivityEvent) => void;

const listeners = new Set<Listener>();

export function subscribeTaskActivity(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function notifyTaskActivity(event: TaskActivityEvent): void {
  for (const listener of [...listeners]) {
    try {
      listener(event);
    } catch (err) {
      console.error('[task-activity] listener threw:', err);
    }
  }
}
