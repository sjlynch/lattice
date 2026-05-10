import fs from 'node:fs/promises';
import path from 'node:path';
import { canonicalProjectPath } from './projectPath.js';
import type { Task } from './tasks.js';

export type TaskMigrationContext = {
  legacyGlobalTasks: string;
  projectDirName: string;
  projectTasksFilename: string;
  projectTasksBackupFilename: string;
  homeProjectDir: (projectPath: string) => string;
  projectTasksFile: (projectPath: string) => string;
  projectTasksBackupFile: (projectPath: string) => string;
  knownProjects: Set<string>;
  persistKnownProjects: () => Promise<void>;
};

// Legacy in-project paths. Read once during migration and otherwise
// untouched — the legacy file is never deleted (acts as belt-and-braces
// for users who roll back to a pre-2026-05-09 build).
function legacyProjectTasksFile(
  projectPath: string,
  ctx: TaskMigrationContext,
): string {
  return path.join(projectPath, ctx.projectDirName, ctx.projectTasksFilename);
}

function legacyProjectTasksBackupFile(
  projectPath: string,
  ctx: TaskMigrationContext,
): string {
  return path.join(
    projectPath,
    ctx.projectDirName,
    ctx.projectTasksBackupFilename,
  );
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
export async function migrateInProjectTasksToHome(
  projectPath: string,
  ctx: TaskMigrationContext,
): Promise<void> {
  const home = ctx.homeProjectDir(projectPath);
  const homeMain = ctx.projectTasksFile(projectPath);
  const homeBackup = ctx.projectTasksBackupFile(projectPath);
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
  for (const src of [
    legacyProjectTasksFile(projectPath, ctx),
    legacyProjectTasksBackupFile(projectPath, ctx),
  ]) {
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

export async function migrateLegacy(ctx: TaskMigrationContext): Promise<void> {
  const LEGACY_GLOBAL_TASKS = ctx.legacyGlobalTasks;
  const { projectTasksFile, knownProjects, persistKnownProjects } = ctx;
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
