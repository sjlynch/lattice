// Task CRUD + lifecycle (run, resume, merge) + live subscription.

import { asJson } from './http';
import { subscribeWs } from './ws';
import type {
  MergeTaskResult,
  RunTaskResult,
  Task,
  TaskStatus,
} from './types';

export async function fetchTasks(projectPath: string): Promise<Task[]> {
  return asJson<Task[]>(
    await fetch(`/api/tasks?project=${encodeURIComponent(projectPath)}`),
  );
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

export async function runTask(id: string, harness?: 'claude' | 'pi'): Promise<RunTaskResult> {
  return asJson<RunTaskResult>(
    await fetch(`/api/tasks/${encodeURIComponent(id)}/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ harness }),
    }),
  );
}

export async function resumeTask(id: string, harness?: 'claude' | 'pi'): Promise<RunTaskResult> {
  return asJson<RunTaskResult>(
    await fetch(`/api/tasks/${encodeURIComponent(id)}/resume`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ harness }),
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

export function subscribeTasks(
  projectPath: string,
  onUpdate: (tasks: Task[]) => void,
): () => void {
  return subscribeWs<{ type: string; tasks?: Task[] }>(
    `/ws/tasks?project=${encodeURIComponent(projectPath)}`,
    (msg) => {
      if (msg.type === 'tasks' && msg.tasks) onUpdate(msg.tasks);
    },
  );
}
