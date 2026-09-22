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
  probeConcurrency?: number;
};

// Worktrees probed at once (two short git processes each).
const PROBE_CONCURRENCY = 8;

// `Promise.all(items.map(fn))` with at most `limit` calls in flight; results
// keep input order.
async function mapBounded<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

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
  const probeConcurrency = Math.max(1, deps.probeConcurrency ?? PROBE_CONCURRENCY);
  const cache = createTtlCache<WorktreeModifiedPayload>(
    deps.ttlMs ?? RESULT_TTL_MS,
    deps.now,
  );

  // Single-flight per project: the TTL cache only fills once a load completes,
  // so concurrent requests (several graph clients, or one client's refresh
  // racing a slow git) each spawned two git processes per active task.
  const inFlight = new Map<string, Promise<WorktreeModifiedPayload>>();

  const load = (projectPath: string): Promise<WorktreeModifiedPayload> => {
    const cacheKey = canonicalProjectPath(projectPath);
    const cached = cache.get(cacheKey);
    if (cached) return Promise.resolve(cached);
    const running = inFlight.get(cacheKey);
    if (running) return running;
    const promise = loadUncached(projectPath, cacheKey).finally(() => {
      if (inFlight.get(cacheKey) === promise) inFlight.delete(cacheKey);
    });
    inFlight.set(cacheKey, promise);
    return promise;
  };

  const loadUncached = async (projectPath: string, cacheKey: string): Promise<WorktreeModifiedPayload> => {
    const tasks = await loadTasks(projectPath);
    const active = tasks.filter(isActiveWorktreeTask);

    let payload: WorktreeModifiedPayload;
    if (active.length === 0) {
      payload = { tasks: [] };
    } else {
      const baseBranch = await resolveBaseBranch(projectPath);
      // Bounded: each probe spawns two git processes, and a "Run All" board
      // has dozens of active worktrees — an unbounded fan-out launched ~2N git
      // processes at once on every `W` press.
      const results = await mapBounded(active, probeConcurrency, async (t) => ({
        taskId: t.id,
        colorIndex: t.colorIndex,
        files: await probeModifiedFiles(t, baseBranch),
      }));
      payload = { tasks: results.filter((t) => t.files.length > 0) };
    }

    cache.set(cacheKey, payload);
    return payload;
  };

  return { load, clearCache: cache.clear };
}

export const worktreeModifiedService = createWorktreeModifiedService();
