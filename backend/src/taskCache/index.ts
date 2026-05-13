import { TaskCacheManager } from './manager.js';
import type { Task, TaskStatus, TaskSubscriber, TaskUpdates } from './types.js';

export { TaskCacheManager } from './manager.js';
export {
  PROJECT_DIR_NAME,
  PROJECT_TASKS_BACKUP_FILENAME,
  PROJECT_TASKS_FILENAME,
} from './paths.js';
export type { Task, TaskStatus, TaskSubscriber, TaskUpdates } from './types.js';

const taskCache = new TaskCacheManager();

export function subscribe(fn: TaskSubscriber): () => void {
  return taskCache.subscribe(fn);
}

export async function updateTaskCrashSafe(
  id: string,
  updates: TaskUpdates,
): Promise<Task | null> {
  return taskCache.updateTaskCrashSafe(id, updates);
}

// Bypass the debounce and write the task cache to disk right now.
// Call this after critical state transitions (merge finalization) so the
// update survives a backend crash or hot-restart that would otherwise drop
// the in-memory change before the 100 ms timer fires.
export async function flushPersist(projectPath: string): Promise<void> {
  return taskCache.flushPersist(projectPath);
}

export async function backupTasksFile(projectPath: string): Promise<void> {
  return taskCache.backupTasksFile(projectPath);
}

export async function restoreTasksFromBackupIfMissing(
  projectPath: string,
): Promise<void> {
  return taskCache.restoreTasksFromBackupIfMissing(projectPath);
}

export async function restoreAllProjectsFromBackup(): Promise<void> {
  return taskCache.restoreAllProjectsFromBackup();
}

export async function listReadyToMergeTasks(): Promise<Task[]> {
  return taskCache.listReadyToMergeTasks();
}

export async function listKnownProjects(): Promise<string[]> {
  return taskCache.listKnownProjects();
}

export async function listTasks(projectPath: string): Promise<Task[]> {
  return taskCache.listTasks(projectPath);
}

export async function getTask(id: string): Promise<Task | null> {
  return taskCache.getTask(id);
}

export async function createTask(
  projectPath: string,
  title: string,
  description?: string,
): Promise<Task> {
  return taskCache.createTask(projectPath, title, description);
}

export async function updateTask(
  id: string,
  updates: TaskUpdates,
): Promise<Task | null> {
  return taskCache.updateTask(id, updates);
}

export async function reorderTasksInLane(
  projectPath: string,
  status: TaskStatus,
  ids: string[],
): Promise<boolean> {
  return taskCache.reorderTasksInLane(projectPath, status, ids);
}

export async function deleteTask(id: string): Promise<boolean> {
  return taskCache.deleteTask(id);
}
