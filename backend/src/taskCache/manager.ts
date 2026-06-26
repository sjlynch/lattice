import { generateTaskId } from '../ids.js';
import { canonicalProjectPath } from '../projectPath.js';
import { ProjectStateManager } from '../projectStateManager.js';
import { TaskMigrations } from './migrations.js';
import { projectTasksFile } from './paths.js';
import { ProjectsIndex } from './projectsIndex.js';
import { applyTaskUpdate, type TaskLookup } from './taskUpdate.js';
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

  // Resolve a task by id even if its project isn't loaded yet — the shared
  // cache-miss fallback lives in ProjectStateManager (covering Stop-hook
  // callbacks for tasks whose project hasn't been opened this session). This
  // supplies the task id accessor and the migration-triggering load strategy.
  private withTaskAcrossProjects<T>(
    id: string,
    fn: (lookup: TaskLookup) => T | Promise<T>,
  ): Promise<T | null> {
    return this.withItemAcrossProjects<Task, T>(
      id,
      (t) => t.id,
      () => this.loadAllKnown(),
      ({ project, list, idx, item }) =>
        fn({ project, tasks: list, idx, task: item }),
    );
  }

  // Write a task update to disk BEFORE touching the in-memory cache, then
  // sync the cache to match. If the server crashes between the disk write
  // and the cache update, the next boot reads the correct state from disk.
  // Use this for critical one-way transitions (e.g. ready_to_merge → qa)
  // where losing the update would leave the system in an inconsistent state.
  //
  // Runs under the shared per-project write lock so it cannot interleave with
  // a sibling create/update for the same project (the lost-concurrent-mutation
  // bug): a Stop-hook flip or a sibling run-attempt bump landing during the
  // disk write used to be reverted when this resumed and committed its pre-await
  // snapshot. Inside the lock, after the disk write, we re-read the LIVE cache
  // and re-apply only this task's delta — never the whole pre-write snapshot.
  public async updateTaskCrashSafe(
    id: string,
    updates: TaskUpdates,
  ): Promise<Task | null> {
    return this.withLockedItemAcrossProjects<Task, Task | null>(
      id,
      (t) => t.id,
      () => this.loadAllKnown(),
      async ({ project, list, idx }) => {
        const { updated, updatedList } = applyTaskUpdate(list, idx, updates);
        // Step 1: write to disk FIRST. A crash here leaves disk as it was — safe.
        try {
          await this.writeStateNow(project, updatedList);
        } catch (e) {
          console.error('[tasks] updateTaskCrashSafe disk write failed:', e);
          return null;
        }
        // Disk is up to date; drop any pending debounce so it can't later flush
        // a staler snapshot over it.
        this.cancelPendingPersist(project);
        // Step 2: sync the cache. Re-read the LIVE cache and re-apply only this
        // task's delta to THAT array, never the pre-write snapshot — so a
        // sibling mutation committed during the disk write isn't reverted. The
        // per-project lock already excludes concurrent writers; this also keeps
        // the path correct against any future writer that bypasses the lock.
        const live = this.getCached(project) ?? [];
        const liveIdx = live.findIndex((t) => t.id === id);
        const synced =
          liveIdx === -1
            ? updatedList
            : live.map((t, i) => (i === liveIdx ? updated : t));
        this.setCached(project, synced);
        this.notifyProject(project);
        return updated;
      },
    );
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
    // Read-modify-write under the per-project lock so two concurrent creates
    // (or a create racing an updateTaskCrashSafe disk write) both land.
    return this.runProjectWrite(key, () => {
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
    });
  }

  public async updateTask(id: string, updates: TaskUpdates): Promise<Task | null> {
    return this.withLockedItemAcrossProjects<Task, Task>(
      id,
      (t) => t.id,
      () => this.loadAllKnown(),
      ({ project, list, idx }) => {
        const { updated, updatedList } = applyTaskUpdate(list, idx, updates);
        this.setCached(project, updatedList);
        this.schedulePersist(project);
        this.notifyProject(project);
        return updated;
      },
    );
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
    return this.runProjectWrite(key, () => {
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
    });
  }

  public async deleteTask(id: string): Promise<boolean> {
    const deleted = await this.withLockedItemAcrossProjects<Task, boolean>(
      id,
      (t) => t.id,
      () => this.loadAllKnown(),
      ({ project, list, idx }) => {
        this.setCached(project, list.filter((_, i) => i !== idx));
        this.schedulePersist(project);
        this.notifyProject(project);
        return true;
      },
    );
    return deleted ?? false;
  }
}
