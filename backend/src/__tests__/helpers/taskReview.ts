// Shared real task-store fixtures; all CLI/git/spawn side effects are injected.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createTask, updateTaskCrashSafe, type Task } from '../../tasks.js';
import { projectTasksFile } from '../../taskCache/paths.js';
import type { ReviewDeps } from '../../taskReview/service.js';
import type { ReviewResult } from '../../taskReview/runner.js';

export const HEAD = 'a'.repeat(40);
export const verdict = { verdict: 'reject', p: 25, reason: 'Misses missing keys', reviewer: 'codex/gpt-6.1-sol' } satisfies ReviewResult;
export const deps = (patch: Partial<ReviewDeps> = {}): ReviewDeps => ({
  head: async () => HEAD,
  run: async () => ({ ...verdict, verdict: 'accept', p: 99 }),
  keep: async (task) => `${task.branch}-attempt-1`, cleanup: async () => true, enqueue: async () => {}, ...patch,
});
export async function fixture(project: string, attempt: 1 | 2 = 1): Promise<Task> {
  const task = await createTask(project, 'Fix keys', 'Keep the task text');
  return (await updateTaskCrashSafe(task.id, { status: 'in_progress', branch: `lattice/${task.id}`,
    worktreePath: path.join(project, 'fake-checkout'), summary: 'Implemented fallback', workflowRunId: 'wf_1', workflowStepIndex: 3,
    review: { status: 'reviewing', head: HEAD, startedAt: 100, attempt },
  }))!;
}
export async function onDisk(task: Task): Promise<Task> {
  const tasks = JSON.parse(await fs.readFile(projectTasksFile(task.projectPath), 'utf8')) as Task[];
  return tasks.find((row) => row.id === task.id)!;
}
export async function waitFor(check: () => Promise<boolean>): Promise<void> {
  for (let i = 0; i < 300; i++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail('review did not settle');
}

