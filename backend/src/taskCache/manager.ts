import { generateTaskId } from '../ids.js';
import { canonicalProjectPath } from '../projectPath.js';
import { ProjectStateManager } from '../projectStateManager.js';
import { TaskMigrations } from './migrations.js';
import { projectTasksFile } from './paths.js';
import { ProjectsIndex } from './projectsIndex.js';
import { applyTaskUpdate, findTaskInProjects, type TaskLookup } from './taskUpdate.js';
import type { Task, TaskStatus, TaskSubscriber, TaskUpdates } from './types.js';

export type TaskCacheManagerOptions = {
  projectsIndex?: ProjectsIndex;
  migrations?: TaskMigrations;
};

export class TaskCacheManager extends ProjectStateManager<Task[], TaskSubscriber> {
  public readonly projectsIndex: ProjectsIndex;
  public readonly migrations: TaskMigrations;

  constructor(opts: TaskCacheManagerOptions = {}) {
    super({
      name: 'tasks',
      fileForProject: projectTasksFile,
      defaultState: () => [],
      deserialize: (raw) => (Array.isArray(raw) ? (raw as Task[]) : []),
      snapshot: (tasks) => [...tasks],
    });
    this.projectsIndex = opts.projectsIndex ?? new ProjectsIndex();
    this.migrations = opts.migrations ?? new TaskMigrations(this.projectsIndex);
  }

  public async ensureProjectLoaded(projectPath: string): Promise<string> {
    const key = canonicalProjectPath(projectPath);
    await this.projectsIndex.loadKnownProjects();
    await this.migrations.runLegacyOnce();
    if (!this.projectsIndex.has(key)) {
      this.projectsIndex.add(key);
      await this.projectsIndex.persistKnownProjects();
    }
    if (this.isLoaded(key)) return key;
    // First-touch: migrate the legacy `<project>/.lattice/tasks.json` into
    // the new home-dir location. No-op if already migrated or no legacy.
    await this.migrations.runFirstTouch(key);
    await this.loadIfNeeded(key);
    return key;
  }

  public async loadAllKnown(): Promise<void> {
    await this.projectsIndex.loadKnownProjects();
    await this.migrations.runLegacyOnce();
    for (const p of this.projectsIndex.values()) {
      if (!this.isLoaded(p)) {
        // eslint-disable-next-line no-await-in-loop
        await this.ensureProjectLoaded(p);
      }
    }
  }

  // Iterator over the per-project task lists currently held in memory.
  // Exposed for recovery helpers (e.g. listReadyToMergeTasks) that need to
  // scan across every loaded project without each one knowing the cache
  // internals.
  public loadedTasks(): Iterable<Task[]> {
    return this.cacheValues();
  }

  private findTaskInLoadedProjects(id: string): TaskLookup | null {
    return findTaskInProjects(this.cacheEntries(), id);
  }

  private async withTaskAcrossProjects<T>(
    id: string,
    fn: (lookup: TaskLookup) => T | Promise<T>,
  ): Promise<T | null> {
    const cached = this.findTaskInLoadedProjects(id);
    if (cached) return fn(cached);

    // Load every known project and try again. Covers Stop-hook callbacks for
    // tasks whose project hasn't been opened yet this session.
    await this.loadAllKnown();
    const loaded = this.findTaskInLoadedProjects(id);
    if (loaded) return fn(loaded);
    return null;
  }

  // Write a task update to disk BEFORE touching the in-memory cache, then
  // sync the cache to match. If the server crashes between the disk write
  // and the cache update, the next boot reads the correct state from disk.
  // Use this for critical one-way transitions (e.g. ready_to_merge → qa)
  // where losing the update would leave the system in an inconsistent state.
  public async updateTaskCrashSafe(
    id: string,
    updates: TaskUpdates,
  ): Promise<Task | null> {
    await this.loadAllKnown();
    for (const [project, tasks] of this.cacheEntries()) {
      const idx = tasks.findIndex((t) => t.id === id);
      if (idx === -1) continue;
      const { updated, updatedList } = applyTaskUpdate(tasks, idx, updates);
      // Step 1: write to disk. A crash here leaves disk as it was — safe.
      try {
        await this.writeStateNow(project, updatedList);
      } catch (e) {
        console.error('[tasks] updateTaskCrashSafe disk write failed:', e);
        return null;
      }
      // Cancel any pending debounce timer — disk is already up to date.
      this.cancelPendingPersist(project);
      // Step 2: sync in-memory cache. A crash here is harmless — disk wins on restart.
      this.setCached(project, updatedList);
      this.notifyProject(project);
      return updated;
    }
    return null;
  }

  public async listTasks(projectPath: string): Promise<Task[]> {
    const key = await this.ensureProjectLoaded(projectPath);
    return [...(this.getCached(key) ?? [])];
  }

  public async getTask(id: string): Promise<Task | null> {
    return this.withTaskAcrossProjects(id, ({ task }) => task);
  }

  public async createTask(
    projectPath: string,
    title: string,
    description?: string,
  ): Promise<Task> {
    const key = await this.ensureProjectLoaded(projectPath);
    const tasks = this.getCached(key) ?? [];
    const t: Task = {
      id: generateTaskId(),
      projectPath: key,
      title: title.trim(),
      description: description?.trim() || undefined,
      status: 'open',
      createdAt: Date.now(),
    };
    const updatedList = [...tasks, t];
    this.setCached(key, updatedList);
    this.schedulePersist(key);
    this.notifyProject(key);
    return t;
  }

  public async updateTask(id: string, updates: TaskUpdates): Promise<Task | null> {
    return this.withTaskAcrossProjects(id, ({ project, tasks, idx }) => {
      const { updated, updatedList } = applyTaskUpdate(tasks, idx, updates);
      this.setCached(project, updatedList);
      this.schedulePersist(project);
      this.notifyProject(project);
      return updated;
    });
  }

  // Rewrite the order of tasks inside a single lane. `ids` lists the task IDs
  // in their new top-to-bottom order. Each listed task gets its status set to
  // `status` (handles cross-lane drops that pick a position) and its sortOrder
  // rewritten to its position in the array. Tasks not listed are not touched.
  public async reorderTasksInLane(
    projectPath: string,
    status: TaskStatus,
    ids: string[],
  ): Promise<boolean> {
    const key = await this.ensureProjectLoaded(projectPath);
    const tasks = this.getCached(key);
    if (!tasks) return false;
    let changed = false;
    const idToIndex = new Map(ids.map((id, i) => [id, i]));
    const updatedList = tasks.map((t) => {
      const i = idToIndex.get(t.id) ?? -1;
      if (i === -1) return t;
      if (t.status === status && t.sortOrder === i) return t;
      changed = true;
      return { ...t, status, sortOrder: i };
    });
    if (changed) {
      this.setCached(key, updatedList);
      this.schedulePersist(key);
      this.notifyProject(key);
    }
    return true;
  }

  public async deleteTask(id: string): Promise<boolean> {
    const deleted = await this.withTaskAcrossProjects(id, ({ project, tasks, idx }) => {
      this.setCached(project, tasks.filter((_, i) => i !== idx));
      this.schedulePersist(project);
      this.notifyProject(project);
      return true;
    });
    return deleted ?? false;
  }
}
