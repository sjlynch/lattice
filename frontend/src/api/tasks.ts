// Task CRUD + lifecycle (run, resume, merge) + live subscription.

import { asJson } from './http';
import { subscribeWs } from './ws';
import type {
  MergeTaskResult,
  RunTaskResult,
  Task,
  TaskSpawnedEvent,
  TaskStatus,
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

// `/ws/tasks` carries two message types: the full task-list snapshot and,
// for queued runs, a `task-spawned` event delivering the pty. `onSpawned`
// fires for the latter so the caller can lazy-mount the task's terminal.
type TasksWsMessage =
  | { type: 'tasks'; tasks: Task[] }
  | ({ type: 'task-spawned' } & TaskSpawnedEvent);

export function subscribeTasks(
  projectPath: string,
  onUpdate: (tasks: Task[]) => void,
  onSpawned?: (event: TaskSpawnedEvent) => void,
): () => void {
  return subscribeWs<TasksWsMessage>(
    `/ws/tasks?project=${encodeURIComponent(projectPath)}`,
    (msg) => {
      if (msg.type === 'tasks') onUpdate(msg.tasks);
      else if (msg.type === 'task-spawned') onSpawned?.(msg);
    },
  );
}
