import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const LATTICE_HOME = path.join(os.homedir(), '.lattice');
const PROJECTS_INDEX = path.join(LATTICE_HOME, 'projects.json');
const LEGACY_GLOBAL_TASKS = path.join(LATTICE_HOME, 'tasks.json');

export const PROJECT_DIR_NAME = '.lattice';
export const PROJECT_TASKS_FILENAME = 'tasks.json';

function projectTasksFile(projectPath: string): string {
  return path.join(projectPath, PROJECT_DIR_NAME, PROJECT_TASKS_FILENAME);
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
  worktreePath?: string;
  branch?: string;
  startedAt?: number;
  completedAt?: number;
  mergedAt?: number;
  conflict?: boolean;
  // When the conflict was first detected. Drives the "stuck for X min"
  // indicator on conflict cards so the user can spot a hung resolver.
  conflictStartedAt?: number;
  // Manual ordering within a lane. Lower values sort first. Tasks without a
  // value fall back to `-createdAt` so newly-created tasks land on top, which
  // matches the pre-reorder behavior.
  sortOrder?: number;
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
  try {
    const raw = await fs.readFile(PROJECTS_INDEX, 'utf8');
    const list = JSON.parse(raw) as string[];
    if (Array.isArray(list)) for (const p of list) knownProjects.add(p);
  } catch {
    /* no index yet */
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
    if (!byProject.has(t.projectPath)) byProject.set(t.projectPath, []);
    byProject.get(t.projectPath)!.push(t);
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

async function ensureProjectLoaded(projectPath: string): Promise<void> {
  await loadKnownProjects();
  await migrateLegacy();
  if (!knownProjects.has(projectPath)) {
    knownProjects.add(projectPath);
    await persistKnownProjects();
  }
  if (projectLoaded.get(projectPath)) return;
  projectLoaded.set(projectPath, true);
  try {
    const raw = await fs.readFile(projectTasksFile(projectPath), 'utf8');
    const parsed = JSON.parse(raw) as Task[];
    if (Array.isArray(parsed)) projectCache.set(projectPath, parsed);
  } catch {
    projectCache.set(projectPath, []);
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

// Bypass the debounce and write the task cache to disk right now.
// Call this after critical state transitions (merge finalization) so the
// update survives a backend crash or hot-restart that would otherwise drop
// the in-memory change before the 100 ms timer fires.
export async function flushPersist(projectPath: string): Promise<void> {
  const timer = persistTimers.get(projectPath);
  if (timer) {
    clearTimeout(timer);
    persistTimers.delete(projectPath);
  }
  const tasks = projectCache.get(projectPath) ?? [];
  const file = projectTasksFile(projectPath);
  try {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify(tasks, null, 2), 'utf8');
  } catch (e) {
    console.error('[tasks] flushPersist failed for', projectPath, e);
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

export async function listTasks(projectPath: string): Promise<Task[]> {
  await ensureProjectLoaded(projectPath);
  return [...(projectCache.get(projectPath) ?? [])];
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
  await ensureProjectLoaded(projectPath);
  const tasks = projectCache.get(projectPath) ?? [];
  const t: Task = {
    id: `t_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    projectPath,
    title: title.trim(),
    description: description?.trim() || undefined,
    status: 'open',
    createdAt: Date.now(),
  };
  tasks.push(t);
  projectCache.set(projectPath, tasks);
  schedulePersist(projectPath);
  notify(projectPath);
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
    tasks[idx] = {
      ...prev,
      ...updates,
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
    tasks[idx] = {
      ...prev,
      ...updates,
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
  await ensureProjectLoaded(projectPath);
  const tasks = projectCache.get(projectPath);
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
    schedulePersist(projectPath);
    notify(projectPath);
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
