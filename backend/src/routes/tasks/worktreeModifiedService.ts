import { listTasks, type Task } from '../../tasks.js';
import { canonicalProjectPath } from '../../projectPath.js';
import { RESULT_TTL_MS } from './worktreeModifiedConstants.js';
import { createTtlCache } from './worktreeModifiedCache.js';
import {
  baseBranchResolver,
  modifiedFilesForTask,
} from './worktreeModifiedGit.js';

export type WorktreeModifiedPayload = {
  tasks: Array<{ taskId: string; colorIndex: Task['colorIndex']; files: string[] }>;
};

export type WorktreeModifiedServiceDeps = {
  listTasks?: (projectPath: string) => Promise<Task[]>;
  resolveBaseBranch?: (projectPath: string) => Promise<string>;
  modifiedFilesForTask?: (task: Task, baseBranch: string) => Promise<string[]>;
  ttlMs?: number;
  now?: () => number;
};

function isActiveWorktreeTask(task: Task): boolean {
  return (
    (task.status === 'in_progress' || task.status === 'ready_to_merge') &&
    Boolean(task.worktreePath)
  );
}

export function createWorktreeModifiedService(
  deps: WorktreeModifiedServiceDeps = {},
) {
  const loadTasks = deps.listTasks ?? listTasks;
  const resolveBaseBranch = deps.resolveBaseBranch ?? baseBranchResolver.resolve;
  const probeModifiedFiles = deps.modifiedFilesForTask ?? modifiedFilesForTask;
  const cache = createTtlCache<WorktreeModifiedPayload>(
    deps.ttlMs ?? RESULT_TTL_MS,
    deps.now,
  );

  const load = async (projectPath: string): Promise<WorktreeModifiedPayload> => {
    const cacheKey = canonicalProjectPath(projectPath);
    const cached = cache.get(cacheKey);
    if (cached) return cached;

    const tasks = await loadTasks(projectPath);
    const active = tasks.filter(isActiveWorktreeTask);

    let payload: WorktreeModifiedPayload;
    if (active.length === 0) {
      payload = { tasks: [] };
    } else {
      const baseBranch = await resolveBaseBranch(projectPath);
      const results = await Promise.all(
        active.map(async (t) => ({
          taskId: t.id,
          colorIndex: t.colorIndex,
          files: await probeModifiedFiles(t, baseBranch),
        })),
      );
      payload = { tasks: results.filter((t) => t.files.length > 0) };
    }

    cache.set(cacheKey, payload);
    return payload;
  };

  return { load, clearCache: cache.clear };
}

export const worktreeModifiedService = createWorktreeModifiedService();
