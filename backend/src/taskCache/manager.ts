import path from 'node:path';
import { generateTaskId } from '../ids.js';
import { canonicalProjectPath } from '../projectPath.js';
import { ProjectIdentityConflictError, matchesStoredProjectIdentity } from '../projectIdentity.js';
import { ProjectStateManager } from '../projectStateManager.js';
import { applyCrashSafeTaskUpdate } from './crashSafeUpdate.js';
import { TaskMigrations } from './migrations.js';
import { projectTasksFile } from './paths.js';
import { isStructurallyJunkPath } from './pruneIndex.js';
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
      // A file that parses but isn't a task array (`{}`, `null`, a wrapper
      // object) is corruption, not an empty board: throwing routes it through
      // the load's preserve-aside path. Mapping it to `[]` let the next
      // mutation silently overwrite the unread bytes with a one-task list.
      deserialize: (raw) => {
        if (!Array.isArray(raw)) throw new Error('expected a JSON array of tasks');
        return raw as Task[];
      },
      snapshot: (tasks) => [...tasks],
      // A task mutation still inside its 100 ms debounce must survive a
      // `process.exit` (signal handler, fatal guard). Safe: this store's
      // on-disk shape is its cached list (writeStateNow is only overridden by
      // test fakes, whose pending timers fire before a natural test exit).
      flushOnExit: true,
    });
    this.projectsIndex = opts.projectsIndex ?? new ProjectsIndex();
    this.migrations = opts.migrations ?? new TaskMigrations(this.projectsIndex);
  }

  public async ensureProjectLoaded(projectPath: string): Promise<string> {
    const key = canonicalProjectPath(projectPath);
    await this.projectsIndex.loadKnownProjects();
    await this.migrations.runLegacyOnce();
    // Read-path pollution guard: only REGISTER a project in the persistent
    // index when the caller's path was absolute. A relative/drive-relative
    // input is shell-escaping damage that canonicalProjectPath just resolved
    // into a plausible-but-bogus absolute path; registering it would leak a
    // phantom entry (the create routes reject these outright, but a bare read
    // still reaches here). Tasks for the resolved key still load, so an
    // already-known project is unaffected — we simply never index a new one
    // that only ever arrived via a mangled read.
    if (!this.projectsIndex.has(key) && path.isAbsolute(projectPath)) {
      this.projectsIndex.add(key);
      await this.projectsIndex.persistKnownProjects();
    }
    if (this.isLoaded(key)) return key;
    // First-touch: migrate the legacy `<project>/.lattice/tasks.json` into
    // the new home-dir location. No-op if already migrated or no legacy.
    await this.migrations.runFirstTouch(key);
    await this.loadIfNeeded(key);
    const tasks = this.getCached(key);
    if (tasks) this.setCached(key, tasks.map((task) =>
      typeof task.projectPath === 'string' && task.projectPath !== key && matchesStoredProjectIdentity(task.projectPath, key)
        ? { ...task, projectPath: key } : task,
    ));
    return key;
  }

  public async loadAllKnown(): Promise<void> {
    await this.projectsIndex.loadKnownProjects();
    await this.migrations.runLegacyOnce();
    for (const p of this.projectsIndex.values()) {
      if (!this.isLoaded(p)) {
        // eslint-disable-next-line no-await-in-loop
        try { await this.ensureProjectLoaded(p); }
        catch (err) {
          if (!(err instanceof ProjectIdentityConflictError)) throw err;
          console.warn(`[tasks] cannot load ambiguous project ${p}: ${err.message}`);
        }
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

  // Crash-safe task update: disk-before-cache with a live-cache re-sync. Runs
  // under the shared per-project write lock so it cannot interleave with a
  // sibling create/update for the same project (the lost-concurrent-mutation
  // bug). The invariant-heavy disk-write / snapshot-re-read / live-cache re-sync
  // logic lives in `applyCrashSafeTaskUpdate`; this method owns the lock and the
  // subscriber notification. The cache ops are bound to `this` so subclass
  // overrides (e.g. a test's fake writeStateNow) still dispatch virtually.
  public async updateTaskCrashSafe(
    id: string,
    updates: TaskUpdates,
  ): Promise<Task | null> {
    return this.withLockedItemAcrossProjects<Task, Task | null>(
      id,
      (t) => t.id,
      () => this.loadAllKnown(),
      async ({ project, list, idx }) => {
        const updated = await applyCrashSafeTaskUpdate(
          {
            writeStateNow: (p, l) => this.writeStateNow(p, l),
            cancelPendingPersist: (p) => this.cancelPendingPersist(p),
            getCached: (p) => this.getCached(p),
            setCached: (p, l) => this.setCached(p, l),
          },
          project,
          list,
          idx,
          id,
          updates,
        );
        if (updated) this.notifyProject(project);
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
      // Defence-in-depth: the HTTP routes validate title/description are
      // strings, but coerce here too so a stray non-string caller can never
      // throw a `.trim()` TypeError (which surfaced as a cryptic 500).
      const t: Task = {
        id: generateTaskId(),
        projectPath: key,
        title: typeof title === 'string' ? title.trim() : '',
        description:
          typeof description === 'string' ? description.trim() || undefined : undefined,
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
      async ({ project, list, idx }) => {
        const remaining = list.filter((_, i) => i !== idx);
        this.setCached(project, remaining);
        this.schedulePersist(project);
        this.notifyProject(project);

        // Scratch projects are intentionally omitted from the durable project
        // index at boot. Remove an empty one immediately as well so disposable
        // E2E/reproduction projects do not accumulate during a long-lived dev
        // server session.
        if (
          remaining.length === 0 &&
          isStructurallyJunkPath(project) &&
          this.projectsIndex.remove(project)
        ) {
          await this.projectsIndex.persistKnownProjects();
        }
        return true;
      },
    );
    return deleted ?? false;
  }
}
