import fs from 'node:fs/promises';
import path from 'node:path';
import { atomicWriteFile } from '../claudeTrust/configFile.js';
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
  // The home dir counts as already migrated if EITHER its main file or its
  // backup exists. A home dir holding only `tasks.backup.json` is a project
  // whose live DB was lost — exactly what boot recovery restores from that
  // backup. Treating it as un-migrated used to copy the (months-old) legacy
  // in-project file over the main file AND the newer backup, destroying the
  // only recent copy. Likewise only ENOENT means "missing": an EPERM/EBUSY
  // probe must not be read as permission to overwrite.
  for (const file of [homeMain, homeBackup]) {
    try {
      await fs.access(file);
      return;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') return;
    }
  }
  let legacyRaw: string | null = null;
  let legacySource = '';
  for (const src of [
    legacyProjectTasksFile(projectPath),
    legacyProjectTasksBackupFile(projectPath),
  ]) {
    try {
      const raw = await fs.readFile(src, 'utf8');
      if (!Array.isArray(JSON.parse(raw))) continue;
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
    await atomicWriteFile(homeMain, legacyRaw);
    await atomicWriteFile(homeBackup, legacyRaw);
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
  let unmigrated = 0;
  for (const t of parsed) {
    // A row with no usable projectPath can't be routed to a project; skip it
    // rather than let canonicalProjectPath throw, which failed the whole
    // migration — and with it every subsequent task load (runLegacyOnce
    // retries, and rethrows, on each one).
    if (!t || typeof t !== 'object' || typeof t.projectPath !== 'string' || !t.projectPath) {
      unmigrated += 1;
      continue;
    }
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
      let eRaw: string | null = null;
      try {
        eRaw = await fs.readFile(file, 'utf8');
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      }
      if (eRaw !== null) {
        // An existing per-project DB that won't parse as a task array must
        // not be replaced by the legacy rows alone (that discarded it). Skip
        // this project; its rows keep the legacy file (set aside below).
        const parsedExisting: unknown = JSON.parse(eRaw);
        if (!Array.isArray(parsedExisting)) {
          throw new Error(`${file} is not a task array; not merging into it`);
        }
        existing = parsedExisting as Task[];
      }
      const merged = mergeById(existing, tasks);
      await atomicWriteFile(file, JSON.stringify(merged, null, 2));
      projectsIndex.add(proj);
    } catch (e) {
      unmigrated += tasks.length;
      console.error('[tasks] legacy migration failed for', proj, e);
    }
  }
  await projectsIndex.persistKnownProjects();
  if (unmigrated === 0) {
    await fs.unlink(LEGACY_GLOBAL_TASKS).catch(() => {});
  } else {
    // Some rows could not be migrated. Deleting the file (as a clean run does)
    // would destroy them; leaving it in place would re-run the merge every
    // boot with the stale legacy rows winning over newer per-project edits.
    // Set it aside instead: recoverable by hand, never re-merged.
    const aside = `${LEGACY_GLOBAL_TASKS}.unmigrated-${Date.now()}`;
    await fs.rename(LEGACY_GLOBAL_TASKS, aside).catch(() => {});
    console.warn(
      `[tasks] ${unmigrated} legacy task(s) could not be migrated; the ` +
        `legacy file was kept at ${aside}`,
    );
  }
  if (parsed.length - unmigrated > 0) {
    console.log(
      `[tasks] migrated ${parsed.length - unmigrated} legacy task(s) to per-project storage`,
    );
  }
}

// Manager-side glue: owns the once-per-process "legacy migration done"
// flag, holds the projectsIndex reference, and exposes the two high-level
// entry points the cache calls on every project load.
export class TaskMigrations {
  private legacyMigrated = false;
  private legacyMigrationPromise: Promise<void> | null = null;

  constructor(private readonly projectsIndex: ProjectsIndex) {}

  // Run the legacy global → per-project migration at most once per process.
  // Single-flight: a concurrent caller awaits the in-flight migration rather
  // than flipping the done-flag and racing ahead to read project files before
  // `migrateLegacy` has finished writing them. The flag flips only after the
  // migration resolves; a failure clears the in-flight promise so a later
  // call retries (migrateLegacy is idempotent).
  async runLegacyOnce(): Promise<void> {
    if (this.legacyMigrated) return;
    if (!this.legacyMigrationPromise) {
      this.legacyMigrationPromise = (async () => {
        try {
          await migrateLegacy(this.projectsIndex);
          this.legacyMigrated = true;
        } finally {
          this.legacyMigrationPromise = null;
        }
      })();
    }
    return this.legacyMigrationPromise;
  }

  // First-touch in-project → home-dir migration for a single project.
  // No-op if the home file already exists, or if no legacy file is found.
  async runFirstTouch(projectKey: string): Promise<void> {
    await migrateInProjectTasksToHome(projectKey);
  }
}
