// Task CRUD + lifecycle (run, resume, merge) + live subscription.

import { asJson } from './http';
import { subscribeWs, subscribeWsShared } from './ws';
import type {
  AgentActivityEvent,
  AgentSession,
  MergeTaskResult,
  RunTaskResult,
  Task,
  TaskActivityEvent,
  TaskSpawnedEvent,
  TaskStatus,
  WorktreeModifiedTask,
} from './types';
import type { AgentHarness } from '../harnesses';

// `/api/tasks` returns an envelope ({project, canonicalProject, hash, count,
// mismatched, tasks}) so agents can detect "these aren't my tasks." The UI
// just unwraps `.tasks`; the envelope's filter is server-side defence in
// depth that we don't need to surface here.
type TasksEnvelope = {
  project: string;
  canonicalProject: string;
  hash: string;
  count: number;
  mismatched: number;
  tasks: Task[];
};

export async function fetchTasks(projectPath: string): Promise<Task[]> {
  const env = await asJson<TasksEnvelope>(
    await fetch(`/api/tasks?project=${encodeURIComponent(projectPath)}`),
  );
  return env.tasks;
}

export async function createTask(
  projectPath: string,
  title: string,
  description?: string,
): Promise<Task> {
  return asJson<Task>(
    await fetch('/api/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project: projectPath, title, description }),
    }),
  );
}

export async function updateTask(
  id: string,
  updates: Partial<Pick<Task, 'title' | 'description' | 'status'>>,
): Promise<Task> {
  return asJson<Task>(
    await fetch(`/api/tasks/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates),
    }),
  );
}

export async function reorderTasks(
  projectPath: string,
  status: TaskStatus,
  ids: string[],
): Promise<void> {
  await asJson<{ ok: true }>(
    await fetch('/api/tasks/reorder', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project: projectPath, status, ids }),
    }),
  );
}

export async function deleteTask(id: string): Promise<void> {
  await asJson<{ ok: true }>(
    await fetch(`/api/tasks/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    }),
  );
}

export async function runTask(id: string, harness?: AgentHarness): Promise<RunTaskResult> {
  return asJson<RunTaskResult>(
    await fetch(`/api/tasks/${encodeURIComponent(id)}/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ harness }),
    }),
  );
}

export async function resumeTask(id: string, harness?: AgentHarness): Promise<RunTaskResult> {
  return asJson<RunTaskResult>(
    await fetch(`/api/tasks/${encodeURIComponent(id)}/resume`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ harness }),
    }),
  );
}

// Drop a queued task run back to a plain Open task. Returns the updated task.
export async function cancelQueuedRun(id: string): Promise<Task> {
  return asJson<Task>(
    await fetch(`/api/tasks/${encodeURIComponent(id)}/cancel-queued-run`, {
      method: 'POST',
    }),
  );
}

export async function mergeTask(id: string): Promise<MergeTaskResult> {
  return asJson<MergeTaskResult>(
    await fetch(`/api/tasks/${encodeURIComponent(id)}/merge`, {
      method: 'POST',
    }),
  );
}

// `/ws/tasks` carries four message types: the full task-list snapshot; for
// queued runs a `task-spawned` event delivering the pty; `task-activity`
// events naming the file a Claude worktree agent is touching; and
// `agent-activity` events naming the file a Claude session OUTSIDE a worktree
// is touching. `onSpawned` lazy-mounts the terminal; `onActivity` /
// `onAgentActivity` drive the graph focus beams.
type TasksWsMessage =
  | { type: 'tasks'; tasks: Task[] }
  | ({ type: 'task-spawned' } & TaskSpawnedEvent)
  | ({ type: 'task-activity' } & TaskActivityEvent)
  | ({ type: 'agent-activity' } & AgentActivityEvent);

// Both the taskboard (`useTaskList`) and the graph (`useAgentOverlay`)
// subscribe to `/ws/tasks` for the same project. Routing through the
// ref-counted `subscribeWsShared` multiplexer means a single socket / single
// JSON.parse fans the high-frequency snapshot + activity frames out to both,
// instead of two independent sockets each parsing every frame. The `tasks`
// snapshot is cached+replayed to a late joiner (e.g. the board opening after
// the graph already opened the socket); the transient `task-spawned` /
// `*-activity` frames are NOT replayed (no stale beam re-fires).
export function subscribeTasks(
  projectPath: string,
  onUpdate: (tasks: Task[]) => void,
  onSpawned?: (event: TaskSpawnedEvent) => void,
  onActivity?: (event: TaskActivityEvent) => void,
  onAgentActivity?: (event: AgentActivityEvent) => void,
): () => void {
  return subscribeWsShared<TasksWsMessage>(
    `/ws/tasks?project=${encodeURIComponent(projectPath)}`,
    (msg) => {
      if (msg.type === 'tasks') onUpdate(msg.tasks);
      else if (msg.type === 'task-spawned') onSpawned?.(msg);
      else if (msg.type === 'task-activity') onActivity?.(msg);
      else if (msg.type === 'agent-activity') onAgentActivity?.(msg);
    },
    (msg) => msg.type === 'tasks',
  );
}

// Presence of Claude sessions running OUTSIDE a task worktree (push /
// workflow step / post-merge hook). Each gets an orange node on the graph.
export function subscribeAgentSessions(
  projectPath: string,
  onUpdate: (sessions: AgentSession[]) => void,
): () => void {
  return subscribeWs<{ type: 'agent-sessions'; sessions: AgentSession[] }>(
    `/ws/agent-sessions?project=${encodeURIComponent(projectPath)}`,
    (msg) => {
      if (msg.type === 'agent-sessions') onUpdate(msg.sessions);
    },
  );
}

// Files changed by every not-yet-merged task (in_progress + ready_to_merge),
// for the `W` worktree-highlight overlay. Recomputed server-side from git on
// each call, so callers should fetch on demand (e.g. when `W` is pressed)
// rather than poll.
export async function fetchWorktreeModified(
  projectPath: string,
): Promise<WorktreeModifiedTask[]> {
  const env = await asJson<{ tasks: WorktreeModifiedTask[] }>(
    await fetch(
      `/api/tasks/worktree-modified?project=${encodeURIComponent(projectPath)}`,
    ),
  );
  return env.tasks;
}
