import fs from 'node:fs/promises';
import { ProjectIdentityConflictError } from '../projectIdentity.js';
import path from 'node:path';
import { canonicalProjectPath } from '../projectPath.js';
import { atomicWriteFile } from '../claudeTrust/configFile.js';
import type { TaskMigrations } from './migrations.js';
import { projectTasksBackupFile, projectTasksFile } from './paths.js';
import type { ProjectsIndex } from './projectsIndex.js';
import type { Task } from './types.js';

// Minimal provider interface the recovery list helpers need from the
// in-memory cache — kept narrow so recovery.ts doesn't depend on the full
// TaskCacheManager shape.
export type LoadedTasksProvider = {
  loadAllKnown(): Promise<void>;
  loadedTasks(): Iterable<Task[]>;
};

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
    // temp → rename, like every other persistence path: a crash mid-write must
    // not leave a truncated backup (this file IS the recovery source).
    await atomicWriteFile(dst, raw);
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
  migrations: TaskMigrations,
): Promise<void> {
  const key = canonicalProjectPath(projectPath);
  await migrations.runFirstTouch(key);
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
    await atomicWriteFile(src, raw);
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
export async function restoreAllProjectsFromBackup(
  projectsIndex: ProjectsIndex,
  migrations: TaskMigrations,
): Promise<void> {
  await projectsIndex.loadKnownProjects();
  for (const proj of projectsIndex.values()) {
    // eslint-disable-next-line no-await-in-loop
    try { await restoreTasksFromBackupIfMissing(proj, migrations); }
    catch (err) {
      if (!(err instanceof ProjectIdentityConflictError)) throw err;
      console.warn(`[tasks] recovery deferred for ambiguous project ${proj}: ${err.message}`);
    }
  }
}

// Returns all ready_to_merge tasks across every known project that have a
// branch on record. Used by startup recovery to detect tasks whose branches
// were deleted (cleanup ran) but whose status was never written to disk.
export async function listReadyToMergeTasks(
  provider: LoadedTasksProvider,
): Promise<Task[]> {
  await provider.loadAllKnown();
  const result: Task[] = [];
  for (const tasks of provider.loadedTasks()) {
    result.push(...tasks.filter((t) => t.status === 'ready_to_merge' && !!t.branch));
  }
  return result;
}

// All project roots Lattice has ever indexed (canonical paths). Used by
// boot recovery to iterate every known project — e.g. the orphaned-worktree
// sweep.
export async function listKnownProjects(
  projectsIndex: ProjectsIndex,
): Promise<string[]> {
  await projectsIndex.loadKnownProjects();
  return projectsIndex.list();
}
