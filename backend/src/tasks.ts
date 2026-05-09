import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { canonicalProjectPath, projectHash } from './projectPath.js';

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

// Legacy in-project paths. Read once during migration and otherwise
// untouched — the legacy file is never deleted (acts as belt-and-braces
// for users who roll back to a pre-2026-05-09 build).
function legacyProjectTasksFile(projectPath: string): string {
  return path.join(projectPath, PROJECT_DIR_NAME, PROJECT_TASKS_FILENAME);
}

function legacyProjectTasksBackupFile(projectPath: string): string {
  return path.join(projectPath, PROJECT_DIR_NAME, PROJECT_TASKS_BACKUP_FILENAME);
}

// One-time copy from the legacy in-project location into the home-dir
// location. Idempotent: skips when the home file already exists, or when
// no legacy file exists. Writes a `.canonical-path` marker so a later
// inspector can tell which project the hashed dir came from.
//
// The legacy file is NOT deleted — keeping it lets a user roll back to
// an older Lattice build without losing tasks. Once the user is
// comfortable, they can delete the legacy `.lattice/tasks.json` files
// themselves.
async function migrateInProjectTasksToHome(projectPath: string): Promise<void> {
  const home = homeProjectDir(projectPath);
  const homeMain = projectTasksFile(projectPath);
  const homeBackup = projectTasksBackupFile(projectPath);
  // Already migrated?
  let homeExists = false;
  try {
    await fs.access(homeMain);
    homeExists = true;
  } catch {
    /* missing — needs migration if legacy exists */
  }
  if (homeExists) return;
  // Try legacy main, then legacy backup.
  let legacyRaw: string | null = null;
  let legacySource = '';
  for (const src of [legacyProjectTasksFile(projectPath), legacyProjectTasksBackupFile(projectPath)]) {
    try {
      const raw = await fs.readFile(src, 'utf8');
      JSON.parse(raw); // sanity-check
      legacyRaw = raw;
      legacySource = src;
      break;
    } catch {
      /* try next source */
    }
  }
  if (legacyRaw === null) return;
  try {
    await fs.mkdir(home, { recursive: true });
    await fs.writeFile(homeMain, legacyRaw, 'utf8');
    await fs.writeFile(homeBackup, legacyRaw, 'utf8');
    await fs.writeFile(
      path.join(home, '.canonical-path'),
      canonicalProjectPath(projectPath),
      'utf8',
    );
    console.warn(
      `[tasks] migrated ${legacySource} → ${homeMain} (home-dir storage; ` +
        `legacy file kept in place for rollback safety)`,
    );
  } catch (e) {
    console.error('[tasks] in-project → home migration failed for', projectPath, e);
  }
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

const projectCache = new Map<string, Task[]>();
const projectLoaded = new Map<string, boolean>();
const persistTimers = new Map<string, NodeJS.Timeout>();
const listeners = new Set<(projectPath: string, tasks: Task[]) => void>();
const knownProjects = new Set<string>();
let knownLoaded = false;
let legacyMigrated = false;

async function loadKnownProjects() {
  if (knownLoaded) return;
  knownLoaded = true;
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
    if (knownProjects.has(canonical)) {
      dirty = true;
      continue;
    }
    knownProjects.add(canonical);
  }
  if (dirty) {
    await persistKnownProjects().catch(() => {});
  }
}

async function persistKnownProjects() {
  try {
    await fs.mkdir(LATTICE_HOME, { recursive: true });
    await fs.writeFile(
      PROJECTS_INDEX,
      JSON.stringify(Array.from(knownProjects), null, 2),
      'utf8',
    );
  } catch (e) {
    console.error('[tasks] persistKnownProjects', e);
  }
}

async function migrateLegacy() {
  if (legacyMigrated) return;
  legacyMigrated = true;
  let raw: string;
  try {
    raw = await fs.readFile(LEGACY_GLOBAL_TASKS, 'utf8');
  } catch {
    return; // no legacy file
  }
  let parsed: Task[];
  try {
    parsed = JSON.parse(raw) as Task[];
  } catch {
    return;
  }
  if (!Array.isArray(parsed)) return;

  const byProject = new Map<string, Task[]>();
  for (const t of parsed) {
    const key = canonicalProjectPath(t.projectPath);
    t.projectPath = key;
    if (!byProject.has(key)) byProject.set(key, []);
    byProject.get(key)!.push(t);
  }
  for (const [proj, tasks] of byProject) {
    try {
      const file = projectTasksFile(proj);
      await fs.mkdir(path.dirname(file), { recursive: true });
      let existing: Task[] = [];
      try {
        const eRaw = await fs.readFile(file, 'utf8');
        existing = JSON.parse(eRaw) as Task[];
      } catch {
        /* none */
      }
      const merged = mergeById(existing, tasks);
      await fs.writeFile(file, JSON.stringify(merged, null, 2), 'utf8');
      knownProjects.add(proj);
    } catch (e) {
      console.error('[tasks] legacy migration failed for', proj, e);
    }
  }
  await persistKnownProjects();
  await fs.unlink(LEGACY_GLOBAL_TASKS).catch(() => {});
  if (parsed.length > 0) {
    console.log(
      `[tasks] migrated ${parsed.length} legacy task(s) to per-project storage`,
    );
  }
}

function mergeById(a: Task[], b: Task[]): Task[] {
  const map = new Map<string, Task>();
  for (const t of a) map.set(t.id, t);
  for (const t of b) map.set(t.id, t);
  return Array.from(map.values());
}

// Stamp a task update with `updatedAt` and any status-transition timestamp the
// caller didn't provide explicitly. Keeps the timestamps aligned regardless of
// which endpoint flipped the status (e.g. /run sets startedAt, but a manual
// PATCH /api/tasks/:id with status=in_progress would otherwise miss it).
function stampTimestamps(
  prev: Task,
  updates: Partial<Omit<Task, 'id' | 'projectPath' | 'createdAt'>>,
): Partial<Omit<Task, 'id' | 'projectPath' | 'createdAt'>> {
  const now = Date.now();
  const out: Partial<Omit<Task, 'id' | 'projectPath' | 'createdAt'>> = {
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

async function ensureProjectLoaded(projectPath: string): Promise<void> {
  const key = canonicalProjectPath(projectPath);
  await loadKnownProjects();
  await migrateLegacy();
  if (!knownProjects.has(key)) {
    knownProjects.add(key);
    await persistKnownProjects();
  }
  if (projectLoaded.get(key)) return;
  projectLoaded.set(key, true);
  // First-touch: migrate the legacy `<project>/.lattice/tasks.json` into
  // the new home-dir location. No-op if already migrated or no legacy.
  await migrateInProjectTasksToHome(key);
  try {
    const raw = await fs.readFile(projectTasksFile(key), 'utf8');
    const parsed = JSON.parse(raw) as Task[];
    if (Array.isArray(parsed)) projectCache.set(key, parsed);
  } catch {
    projectCache.set(key, []);
  }
}

async function loadAllKnown(): Promise<void> {
  await loadKnownProjects();
  await migrateLegacy();
  for (const p of knownProjects) {
    if (!projectLoaded.get(p)) {
      // eslint-disable-next-line no-await-in-loop
      await ensureProjectLoaded(p);
    }
  }
}

function schedulePersist(projectPath: string) {
  if (persistTimers.has(projectPath)) return;
  persistTimers.set(
    projectPath,
    setTimeout(async () => {
      persistTimers.delete(projectPath);
      const tasks = projectCache.get(projectPath) ?? [];
      const file = projectTasksFile(projectPath);
      try {
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file, JSON.stringify(tasks, null, 2), 'utf8');
      } catch (e) {
        console.error('[tasks] persist failed for', projectPath, e);
      }
    }, 100),
  );
}

// Write a task update to disk BEFORE touching the in-memory cache, then
// sync the cache to match. If the server crashes between the disk write
// and the cache update, the next boot reads the correct state from disk.
// Use this for critical one-way transitions (e.g. ready_to_merge → qa)
// where losing the update would leave the system in an inconsistent state.
export async function updateTaskCrashSafe(
  id: string,
  updates: Partial<Omit<Task, 'id' | 'projectPath' | 'createdAt'>>,
): Promise<Task | null> {
  await loadAllKnown();
  for (const [project, tasks] of projectCache.entries()) {
    const idx = tasks.findIndex((t) => t.id === id);
    if (idx === -1) continue;
    const prev = tasks[idx];
    const stamped = stampTimestamps(prev, updates);
    const updated: Task = {
      ...prev,
      ...stamped,
      id: prev.id,
      projectPath: prev.projectPath,
      createdAt: prev.createdAt,
    };
    // Step 1: write to disk. A crash here leaves disk as it was — safe.
    const file = projectTasksFile(project);
    const updatedList = tasks.map((t, i) => (i === idx ? updated : t));
    try {
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, JSON.stringify(updatedList, null, 2), 'utf8');
    } catch (e) {
      console.error('[tasks] updateTaskCrashSafe disk write failed:', e);
      return null;
    }
    // Cancel any pending debounce timer — disk is already up to date.
    const timer = persistTimers.get(project);
    if (timer) {
      clearTimeout(timer);
      persistTimers.delete(project);
    }
    // Step 2: sync in-memory cache. A crash here is harmless — disk wins on restart.
    tasks[idx] = updated;
    notify(project);
    return updated;
  }
  return null;
}

// Bypass the debounce and write the task cache to disk right now.
// Call this after critical state transitions (merge finalization) so the
// update survives a backend crash or hot-restart that would otherwise drop
// the in-memory change before the 100 ms timer fires.
export async function flushPersist(projectPath: string): Promise<void> {
  const key = canonicalProjectPath(projectPath);
  const timer = persistTimers.get(key);
  if (timer) {
    clearTimeout(timer);
    persistTimers.delete(key);
  }
  const tasks = projectCache.get(key) ?? [];
  const file = projectTasksFile(key);
  try {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify(tasks, null, 2), 'utf8');
  } catch (e) {
    console.error('[tasks] flushPersist failed for', key, e);
  }
}

function notify(projectPath: string) {
  const tasks = projectCache.get(projectPath) ?? [];
  const snapshot = [...tasks];
  for (const fn of listeners) fn(projectPath, snapshot);
}

export function subscribe(
  fn: (projectPath: string, tasks: Task[]) => void,
): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

// Snapshot the current on-disk tasks.json to tasks.backup.json. Idempotent:
// overwrites any previous backup. Validates the source parses before writing,
// so a corrupt source never produces a corrupt backup. Called at the start of
// every merge run so a crash that wipes the main file (the .git-deletion
// incident on 2026-05-08 took out tasks.json along with it) is recoverable
// on the next backend boot.
export async function backupTasksFile(projectPath: string): Promise<void> {
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
export async function restoreTasksFromBackupIfMissing(
  projectPath: string,
): Promise<void> {
  const key = canonicalProjectPath(projectPath);
  await migrateInProjectTasksToHome(key);
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
export async function restoreAllProjectsFromBackup(): Promise<void> {
  await loadKnownProjects();
  for (const proj of knownProjects) {
    // eslint-disable-next-line no-await-in-loop
    await restoreTasksFromBackupIfMissing(proj);
  }
}

// Returns all ready_to_merge tasks across every known project that have a
// branch on record. Used by startup recovery to detect tasks whose branches
// were deleted (cleanup ran) but whose status was never written to disk.
export async function listReadyToMergeTasks(): Promise<Task[]> {
  await loadAllKnown();
  const result: Task[] = [];
  for (const tasks of projectCache.values()) {
    result.push(...tasks.filter((t) => t.status === 'ready_to_merge' && !!t.branch));
  }
  return result;
}

export async function listTasks(projectPath: string): Promise<Task[]> {
  const key = canonicalProjectPath(projectPath);
  await ensureProjectLoaded(key);
  return [...(projectCache.get(key) ?? [])];
}

export async function getTask(id: string): Promise<Task | null> {
  // First: search what's already loaded.
  for (const tasks of projectCache.values()) {
    const found = tasks.find((t) => t.id === id);
    if (found) return found;
  }
  // Then: load every known project and try again. Covers Stop-hook
  // callbacks for tasks whose project hasn't been opened yet this session.
  await loadAllKnown();
  for (const tasks of projectCache.values()) {
    const found = tasks.find((t) => t.id === id);
    if (found) return found;
  }
  return null;
}

export async function createTask(
  projectPath: string,
  title: string,
  description?: string,
): Promise<Task> {
  const key = canonicalProjectPath(projectPath);
  await ensureProjectLoaded(key);
  const tasks = projectCache.get(key) ?? [];
  const t: Task = {
    id: `t_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    projectPath: key,
    title: title.trim(),
    description: description?.trim() || undefined,
    status: 'open',
    createdAt: Date.now(),
  };
  tasks.push(t);
  projectCache.set(key, tasks);
  schedulePersist(key);
  notify(key);
  return t;
}

export async function updateTask(
  id: string,
  updates: Partial<Omit<Task, 'id' | 'projectPath' | 'createdAt'>>,
): Promise<Task | null> {
  for (const [project, tasks] of projectCache.entries()) {
    const idx = tasks.findIndex((t) => t.id === id);
    if (idx === -1) continue;
    const prev = tasks[idx];
    const stamped = stampTimestamps(prev, updates);
    tasks[idx] = {
      ...prev,
      ...stamped,
      id: prev.id,
      projectPath: prev.projectPath,
      createdAt: prev.createdAt,
    };
    schedulePersist(project);
    notify(project);
    return tasks[idx];
  }
  // Try after loading other known projects.
  await loadAllKnown();
  for (const [project, tasks] of projectCache.entries()) {
    const idx = tasks.findIndex((t) => t.id === id);
    if (idx === -1) continue;
    const prev = tasks[idx];
    const stamped = stampTimestamps(prev, updates);
    tasks[idx] = {
      ...prev,
      ...stamped,
      id: prev.id,
      projectPath: prev.projectPath,
      createdAt: prev.createdAt,
    };
    schedulePersist(project);
    notify(project);
    return tasks[idx];
  }
  return null;
}

// Rewrite the order of tasks inside a single lane. `ids` lists the task IDs
// in their new top-to-bottom order. Each listed task gets its status set to
// `status` (handles cross-lane drops that pick a position) and its sortOrder
// rewritten to its position in the array. Tasks not listed are not touched.
export async function reorderTasksInLane(
  projectPath: string,
  status: TaskStatus,
  ids: string[],
): Promise<boolean> {
  const key = canonicalProjectPath(projectPath);
  await ensureProjectLoaded(key);
  const tasks = projectCache.get(key);
  if (!tasks) return false;
  const byId = new Map<string, Task>();
  for (const t of tasks) byId.set(t.id, t);
  let changed = false;
  ids.forEach((id, i) => {
    const t = byId.get(id);
    if (!t) return;
    if (t.status !== status || t.sortOrder !== i) {
      t.status = status;
      t.sortOrder = i;
      changed = true;
    }
  });
  if (changed) {
    schedulePersist(key);
    notify(key);
  }
  return true;
}

export async function deleteTask(id: string): Promise<boolean> {
  for (const [project, tasks] of projectCache.entries()) {
    const idx = tasks.findIndex((t) => t.id === id);
    if (idx === -1) continue;
    tasks.splice(idx, 1);
    schedulePersist(project);
    notify(project);
    return true;
  }
  await loadAllKnown();
  for (const [project, tasks] of projectCache.entries()) {
    const idx = tasks.findIndex((t) => t.id === id);
    if (idx === -1) continue;
    tasks.splice(idx, 1);
    schedulePersist(project);
    notify(project);
    return true;
  }
  return false;
}
