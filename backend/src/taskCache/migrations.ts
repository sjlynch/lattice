import fs from 'node:fs/promises';
import path from 'node:path';
import { canonicalProjectPath } from '../projectPath.js';
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
import type { Task } from './types.js';

// Legacy in-project task paths. Read once during first-touch migration and
// otherwise untouched — the legacy file is never deleted (acts as
// belt-and-braces for users who roll back to a pre-2026-05-09 build).
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
export async function migrateInProjectTasksToHome(projectPath: string): Promise<void> {
  const home = homeProjectDir(projectPath);
  const homeMain = projectTasksFile(projectPath);
  const homeBackup = projectTasksBackupFile(projectPath);
  let homeExists = false;
  try {
    await fs.access(homeMain);
    homeExists = true;
  } catch {
    /* missing — needs migration if legacy exists */
  }
  if (homeExists) return;
  let legacyRaw: string | null = null;
  let legacySource = '';
  for (const src of [
    legacyProjectTasksFile(projectPath),
    legacyProjectTasksBackupFile(projectPath),
  ]) {
    try {
      const raw = await fs.readFile(src, 'utf8');
      JSON.parse(raw);
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

function mergeById(a: Task[], b: Task[]): Task[] {
  const map = new Map<string, Task>();
  for (const t of a) map.set(t.id, t);
  for (const t of b) map.set(t.id, t);
  return Array.from(map.values());
}

// One-time global migration from ~/.lattice/tasks.json into per-project
// per-project files. Mutates `projectsIndex` by adding any discovered
// projects and persists it once at the end.
export async function migrateLegacy(projectsIndex: ProjectsIndex): Promise<void> {
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
      projectsIndex.add(proj);
    } catch (e) {
      console.error('[tasks] legacy migration failed for', proj, e);
    }
  }
  await projectsIndex.persistKnownProjects();
  await fs.unlink(LEGACY_GLOBAL_TASKS).catch(() => {});
  if (parsed.length > 0) {
    console.log(
      `[tasks] migrated ${parsed.length} legacy task(s) to per-project storage`,
    );
  }
}

// Manager-side glue: owns the once-per-process "legacy migration done"
// flag, holds the projectsIndex reference, and exposes the two high-level
// entry points the cache calls on every project load.
export class TaskMigrations {
  private legacyMigrated = false;

  constructor(private readonly projectsIndex: ProjectsIndex) {}

  // Run the legacy global → per-project migration at most once per process.
  async runLegacyOnce(): Promise<void> {
    if (this.legacyMigrated) return;
    this.legacyMigrated = true;
    await migrateLegacy(this.projectsIndex);
  }

  // First-touch in-project → home-dir migration for a single project.
  // No-op if the home file already exists, or if no legacy file is found.
  async runFirstTouch(projectKey: string): Promise<void> {
    await migrateInProjectTasksToHome(projectKey);
  }
}
