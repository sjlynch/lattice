import type { Response } from 'express';
import type { Task, TaskStatus } from '../../tasks.js';

export const STATUS_GUARD_ACTIONS: Partial<Record<TaskStatus, string>> = {
  open: 'run',
  in_progress: 'resumed',
  ready_to_merge: 'merged',
};

export function requireTaskStatus(
  task: Task,
  expectedStatus: TaskStatus,
  res: Response,
): boolean {
  if (task.status === expectedStatus) return true;

  res.status(400).json({
    error: `task is "${task.status}"; only ${expectedStatus} tasks can be ${STATUS_GUARD_ACTIONS[expectedStatus] ?? 'processed'}`,
  });
  return false;
}

export function logTaskRouteError(
  task: Task,
  operation: string,
  error: unknown,
): void {
  console.error(
    `[tasks:${operation}] task ${task.id} ("${task.title.slice(0, 60)}") at ${task.projectPath}:`,
    error,
  );
}
