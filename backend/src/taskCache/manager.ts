import fs from 'node:fs/promises';
import path from 'node:path';
import { generateTaskId } from '../ids.js';
import { canonicalProjectPath } from '../projectPath.js';
import { ProjectStateManager } from '../projectStateManager.js';
import {
  migrateInProjectTasksToHome,
  migrateLegacy,
  type TaskMigrationContext,
} from '../taskMigrations.js';
import {
  LEGACY_GLOBAL_TASKS,
  PROJECT_DIR_NAME,
  PROJECT_TASKS_BACKUP_FILENAME,
  PROJECT_TASKS_FILENAME,
  homeProjectDir,
  projectTasksBackupFile,
  projectTasksFile,
} from './paths.js';
import { ProjectsIndex } from './projectsIndex.js';
import type { Task, TaskStatus, TaskSubscriber, TaskUpdates } from './types.js';

type AppliedTaskUpdate = {
  updated: Task;
  updatedList: Task[];
};

type TaskLookup = {
  project: string;
  tasks: Task[];
  idx: number;
  task: Task;
};

export class TaskCacheManager extends ProjectStateManager<Task[], TaskSubscriber> {
  private readonly projectsIndex = new ProjectsIndex();
  private legacyMigrated = false;

  constructor() {
    super({
      name: 'tasks',
      fileForProject: projectTasksFile,
      defaultState: () => [],
      deserialize: (raw) => (Array.isArray(raw) ? (raw as Task[]) : []),
      snapshot: (tasks) => [...tasks],
    });
  }

  private taskMigrationContext(): TaskMigrationContext {
    return {
      legacyGlobalTasks: LEGACY_GLOBAL_TASKS,
      projectDirName: PROJECT_DIR_NAME,
      projectTasksFilename: PROJECT_TASKS_FILENAME,
      projectTasksBackupFilename: PROJECT_TASKS_BACKUP_FILENAME,
      homeProjectDir,
      projectTasksFile,
      projectTasksBackupFile,
      knownProjects: this.projectsIndex.projects,
      persistKnownProjects: () => this.projectsIndex.persistKnownProjects(),
    };
  }

  private async migrateLegacyOnce(): Promise<void> {
    if (this.legacyMigrated) return;
    this.legacyMigrated = true;
    await migrateLegacy(this.taskMigrationContext());
  }

  // Stamp a task update with `updatedAt` and any status-transition timestamp the
  // caller didn't provide explicitly. Keeps the timestamps aligned regardless of
  // which endpoint flipped the status (e.g. /run sets startedAt, but a manual
  // PATCH /api/tasks/:id with status=in_progress would otherwise miss it).
  private stampTimestamps(prev: Task, updates: TaskUpdates): TaskUpdates {
    const now = Date.now();
    const out: TaskUpdates = {
      ...updates,
      updatedAt: now,
    };
    const newStatus = updates.status ?? prev.status;
    if (newStatus !== prev.status) {
      if (newStatus === 'in_progress' && updates.startedAt === undefined && !prev.startedAt) {
        out.startedAt = now;
      }
      if (newStatus === 'ready_to_merge' && updates.completedAt === undefined && !prev.completedAt) {
        out.completedAt = now;
      }
      if (newStatus === 'qa' && updates.mergedAt === undefined && !prev.mergedAt) {
        out.mergedAt = now;
      }
      if (newStatus === 'done' && updates.doneAt === undefined && !prev.doneAt) {
        out.doneAt = now;
      }
    }
    return out;
  }

  public async ensureProjectLoaded(projectPath: string): Promise<string> {
    const key = canonicalProjectPath(projectPath);
    await this.projectsIndex.loadKnownProjects();
    await this.migrateLegacyOnce();
    if (!this.projectsIndex.has(key)) {
      this.projectsIndex.add(key);
      await this.projectsIndex.persistKnownProjects();
    }
    if (this.isLoaded(key)) return key;
    // First-touch: migrate the legacy `<project>/.lattice/tasks.json` into
    // the new home-dir location. No-op if already migrated or no legacy.
    await migrateInProjectTasksToHome(key, this.taskMigrationContext());
    await this.loadIfNeeded(key);
    return key;
  }

  public async loadAllKnown(): Promise<void> {
    await this.projectsIndex.loadKnownProjects();
    await this.migrateLegacyOnce();
    for (const p of this.projectsIndex.values()) {
      if (!this.isLoaded(p)) {
        // eslint-disable-next-line no-await-in-loop
        await this.ensureProjectLoaded(p);
      }
    }
  }

  private _applyTaskUpdate(
    tasks: Task[],
    idx: number,
    updates: TaskUpdates,
  ): AppliedTaskUpdate {
    const prev = tasks[idx];
    const stamped = this.stampTimestamps(prev, updates);
    const updated: Task = {
      ...prev,
      ...stamped,
      id: prev.id,
      projectPath: prev.projectPath,
      createdAt: prev.createdAt,
    };
    return {
      updated,
      updatedList: tasks.map((t, i) => (i === idx ? updated : t)),
    };
  }

  private findTaskInLoadedProjects(id: string): TaskLookup | null {
    for (const [project, tasks] of this.cacheEntries()) {
      const idx = tasks.findIndex((t) => t.id === id);
      if (idx === -1) continue;
      return { project, tasks, idx, task: tasks[idx] };
    }
    return null;
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
      const { updated, updatedList } = this._applyTaskUpdate(tasks, idx, updates);
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

  // Snapshot the current on-disk tasks.json to tasks.backup.json. Idempotent:
  // overwrites any previous backup. Validates the source parses before writing,
  // so a corrupt source never produces a corrupt backup. Called at the start of
  // every merge run so a crash that wipes the main file (the .git-deletion
  // incident on 2026-05-08 took out tasks.json along with it) is recoverable
  // on the next backend boot.
  public async backupTasksFile(projectPath: string): Promise<void> {
    const key = canonicalProjectPath(projectPath);
    const src = projectTasksFile(key);
    const dst = projectTasksBackupFile(key);
    try {
      const raw = await fs.readFile(src, 'utf8');
      JSON.parse(raw);
      await fs.writeFile(dst, raw, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return;
      console.warn('[tasks] backup failed for', key, e);
    }
  }

  // Counterpart to backupTasksFile, called from startup recovery: if tasks.json
  // is missing or unparseable but tasks.backup.json is present and parses,
  // restore from backup. Logs loudly so the operator notices the recovery.
  //
  // Also runs the legacy → home migration first, so a project whose home
  // file never existed but whose legacy `<project>/.lattice/tasks.json` is
  // present gets pulled in here on boot.
  public async restoreTasksFromBackupIfMissing(projectPath: string): Promise<void> {
    const key = canonicalProjectPath(projectPath);
    await migrateInProjectTasksToHome(key, this.taskMigrationContext());
    const src = projectTasksFile(key);
    const dst = projectTasksBackupFile(key);
    let needsRestore = false;
    try {
      const raw = await fs.readFile(src, 'utf8');
      JSON.parse(raw);
    } catch {
      needsRestore = true;
    }
    if (!needsRestore) return;
    try {
      const raw = await fs.readFile(dst, 'utf8');
      JSON.parse(raw);
      await fs.mkdir(path.dirname(src), { recursive: true });
      await fs.writeFile(src, raw, 'utf8');
      console.warn(
        `[tasks] restored ${src} from ${dst} — main file was missing or corrupt`,
      );
    } catch {
      /* no backup, or backup also corrupt — nothing to do */
    }
  }

  // Iterate every project in the global index and restore each from its
  // per-project backup if its tasks.json is missing/corrupt. Boot recovery
  // calls this BEFORE any other tasks.ts read so the in-memory cache is
  // populated from the restored file.
  public async restoreAllProjectsFromBackup(): Promise<void> {
    await this.projectsIndex.loadKnownProjects();
    for (const proj of this.projectsIndex.values()) {
      // eslint-disable-next-line no-await-in-loop
      await this.restoreTasksFromBackupIfMissing(proj);
    }
  }

  // Returns all ready_to_merge tasks across every known project that have a
  // branch on record. Used by startup recovery to detect tasks whose branches
  // were deleted (cleanup ran) but whose status was never written to disk.
  public async listReadyToMergeTasks(): Promise<Task[]> {
    await this.loadAllKnown();
    const result: Task[] = [];
    for (const tasks of this.cacheValues()) {
      result.push(...tasks.filter((t) => t.status === 'ready_to_merge' && !!t.branch));
    }
    return result;
  }

  // All project roots Lattice has ever indexed (canonical paths). Used by
  // boot recovery to iterate every known project — e.g. the orphaned-worktree
  // sweep.
  public async listKnownProjects(): Promise<string[]> {
    await this.projectsIndex.loadKnownProjects();
    return this.projectsIndex.list();
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
      const { updated, updatedList } = this._applyTaskUpdate(tasks, idx, updates);
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
    const updatedList = tasks.map((t) => {
      const i = ids.indexOf(t.id);
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
