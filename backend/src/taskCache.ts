import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { generateTaskId } from './ids.js';
import { canonicalProjectPath, projectHash } from './projectPath.js';
import { ProjectStateManager } from './projectStateManager.js';
import {
  migrateInProjectTasksToHome,
  migrateLegacy,
  type TaskMigrationContext,
} from './taskMigrations.js';

const LATTICE_HOME = path.join(os.homedir(), '.lattice');
const PROJECTS_INDEX = path.join(LATTICE_HOME, 'projects.json');
const LEGACY_GLOBAL_TASKS = path.join(LATTICE_HOME, 'tasks.json');
const PER_PROJECT_BASE = path.join(LATTICE_HOME, 'per-project');

export const PROJECT_DIR_NAME = '.lattice';
export const PROJECT_TASKS_FILENAME = 'tasks.json';
export const PROJECT_TASKS_BACKUP_FILENAME = 'tasks.backup.json';

// Where Lattice stores per-project task data. Moved out of
// `<project>/.lattice/tasks.json` (the legacy location) into
// `~/.lattice/per-project/<hash>/tasks.json` after the 2026-05-09 incident
// took out the in-project location for the third time. Living in the
// home directory means a project-side catastrophe (`.git/` deletion,
// rogue `rm -rf .lattice`, accidental `git clean -fdx`, etc.) can no
// longer destroy the task DB.
//
// Each per-project directory also contains a `.canonical-path` text file
// recording the project root the hash maps to, so a developer browsing
// `~/.lattice/per-project/` can tell which directory belongs to which
// project without needing the index.
function homeProjectDir(projectPath: string): string {
  return path.join(PER_PROJECT_BASE, projectHash(projectPath));
}

function projectTasksFile(projectPath: string): string {
  return path.join(homeProjectDir(projectPath), PROJECT_TASKS_FILENAME);
}

function projectTasksBackupFile(projectPath: string): string {
  return path.join(homeProjectDir(projectPath), PROJECT_TASKS_BACKUP_FILENAME);
}

export type TaskStatus =
  | 'backlog'
  | 'open'
  | 'in_progress'
  | 'ready_to_merge'
  | 'qa'
  | 'done'
  | 'deleted';

export type Task = {
  id: string;
  projectPath: string;
  title: string;
  description?: string;
  status: TaskStatus;
  createdAt: number;
  // Timestamp of the most recent mutation (any field). Set by updateTask /
  // updateTaskCrashSafe; not set by createTask (use createdAt for that).
  updatedAt?: number;
  worktreePath?: string;
  branch?: string;
  startedAt?: number;
  completedAt?: number;
  mergedAt?: number;
  doneAt?: number;
  conflict?: boolean;
  // When the conflict was first detected. Drives the "stuck for X min"
  // indicator on conflict cards so the user can spot a hung resolver.
  conflictStartedAt?: number;
  // Manual ordering within a lane. Lower values sort first. Tasks without a
  // value fall back to `-createdAt` so newly-created tasks land on top, which
  // matches the pre-reorder behavior.
  sortOrder?: number;
  // When this task was spawned by a Workflow run, these record the run it
  // belongs to and which step in that run produced it. The workflow advancer
  // watches for tagged tasks transitioning to `qa` and creates the next step.
  workflowRunId?: string;
  workflowStepIndex?: number;
};

type TaskUpdates = Partial<Omit<Task, 'id' | 'projectPath' | 'createdAt'>>;
type TaskSubscriber = (projectPath: string, tasks: Task[]) => void;

type AppliedTaskUpdate = {
  updated: Task;
  updatedList: Task[];
};

export class TaskCacheManager extends ProjectStateManager<Task[], TaskSubscriber> {
  private readonly knownProjects = new Set<string>();
  private knownLoaded = false;
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
      knownProjects: this.knownProjects,
      persistKnownProjects: () => this.persistKnownProjects(),
    };
  }

  private async migrateLegacyOnce(): Promise<void> {
    if (this.legacyMigrated) return;
    this.legacyMigrated = true;
    await migrateLegacy(this.taskMigrationContext());
  }

  private async loadKnownProjects(): Promise<void> {
    if (this.knownLoaded) return;
    this.knownLoaded = true;
    let raw: string;
    try {
      raw = await fs.readFile(PROJECTS_INDEX, 'utf8');
    } catch {
      return; // no index yet
    }
    let list: unknown;
    try {
      list = JSON.parse(raw);
    } catch {
      return; // corrupt — leave the file alone, start fresh in memory
    }
    if (!Array.isArray(list)) return;

    // Canonicalize every entry. If two entries collapse to the same canonical
    // form (e.g. `f:\rust_etl` and `F:\rust_etl` on Windows), the duplicate is
    // dropped. Both pointed at the same on-disk tasks.json anyway, so there's
    // nothing to merge — we're just deduping the index.
    let dirty = false;
    for (const p of list) {
      if (typeof p !== 'string' || !p) {
        dirty = true;
        continue;
      }
      const canonical = canonicalProjectPath(p);
      if (canonical !== p) dirty = true;
      if (this.knownProjects.has(canonical)) {
        dirty = true;
        continue;
      }
      this.knownProjects.add(canonical);
    }
    if (dirty) {
      await this.persistKnownProjects().catch(() => {});
    }
  }

  private async persistKnownProjects(): Promise<void> {
    try {
      await fs.mkdir(LATTICE_HOME, { recursive: true });
      await fs.writeFile(
        PROJECTS_INDEX,
        JSON.stringify(Array.from(this.knownProjects), null, 2),
        'utf8',
      );
    } catch (e) {
      console.error('[tasks] persistKnownProjects', e);
    }
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
    await this.loadKnownProjects();
    await this.migrateLegacyOnce();
    if (!this.knownProjects.has(key)) {
      this.knownProjects.add(key);
      await this.persistKnownProjects();
    }
    if (this.isLoaded(key)) return key;
    // First-touch: migrate the legacy `<project>/.lattice/tasks.json` into
    // the new home-dir location. No-op if already migrated or no legacy.
    await migrateInProjectTasksToHome(key, this.taskMigrationContext());
    await this.loadIfNeeded(key);
    return key;
  }

  public async loadAllKnown(): Promise<void> {
    await this.loadKnownProjects();
    await this.migrateLegacyOnce();
    for (const p of this.knownProjects) {
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

  private applyCachedTaskUpdate(
    id: string,
    updates: TaskUpdates,
  ): { project: string; updated: Task } | null {
    for (const [project, tasks] of this.cacheEntries()) {
      const idx = tasks.findIndex((t) => t.id === id);
      if (idx === -1) continue;
      const { updated, updatedList } = this._applyTaskUpdate(tasks, idx, updates);
      this.setCached(project, updatedList);
      this.schedulePersist(project);
      this.notifyProject(project);
      return { project, updated };
    }
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
    await this.loadKnownProjects();
    for (const proj of this.knownProjects) {
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
    await this.loadKnownProjects();
    return Array.from(this.knownProjects);
  }

  public async listTasks(projectPath: string): Promise<Task[]> {
    const key = await this.ensureProjectLoaded(projectPath);
    return [...(this.getCached(key) ?? [])];
  }

  public async getTask(id: string): Promise<Task | null> {
    // First: search what's already loaded.
    for (const tasks of this.cacheValues()) {
      const found = tasks.find((t) => t.id === id);
      if (found) return found;
    }
    // Then: load every known project and try again. Covers Stop-hook
    // callbacks for tasks whose project hasn't been opened yet this session.
    await this.loadAllKnown();
    for (const tasks of this.cacheValues()) {
      const found = tasks.find((t) => t.id === id);
      if (found) return found;
    }
    return null;
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
    const cached = this.applyCachedTaskUpdate(id, updates);
    if (cached) return cached.updated;
    // Try after loading other known projects.
    await this.loadAllKnown();
    return this.applyCachedTaskUpdate(id, updates)?.updated ?? null;
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
    for (const [project, tasks] of this.cacheEntries()) {
      const idx = tasks.findIndex((t) => t.id === id);
      if (idx === -1) continue;
      this.setCached(project, tasks.filter((_, i) => i !== idx));
      this.schedulePersist(project);
      this.notifyProject(project);
      return true;
    }
    await this.loadAllKnown();
    for (const [project, tasks] of this.cacheEntries()) {
      const idx = tasks.findIndex((t) => t.id === id);
      if (idx === -1) continue;
      this.setCached(project, tasks.filter((_, i) => i !== idx));
      this.schedulePersist(project);
      this.notifyProject(project);
      return true;
    }
    return false;
  }
}

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
