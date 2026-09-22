import fs from 'node:fs/promises';
import { ProjectIdentityConflictError } from '../projectIdentity.js';
import path from 'node:path';
import { canonicalProjectPath } from '../projectPath.js';
import { atomicWriteFile } from '../claudeTrust/configFile.js';
import type { TaskMigrations } from './migrations.js';
import { projectTasksBackupFile, projectTasksFile } from './paths.js';
import type { ProjectsIndex } from './projectsIndex.js';
import type { Task } from './types.js';

// A task DB is valid only if it parses AND is an array. `{}` / `null` parse,
// but the loader treats them as corrupt (TaskCacheManager's deserialize), so
// backup/restore must agree or they would snapshot or keep a DB the loader
// then moves aside as unreadable.
function isValidTasksJson(raw: string): boolean {
  try {
    return Array.isArray(JSON.parse(raw));
  } catch {
    return false;
  }
}

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
    if (!isValidTasksJson(raw)) throw new Error(`${src} is not a valid task array`);
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
  let srcRaw: string | null = null;
  try {
    srcRaw = await fs.readFile(src, 'utf8');
  } catch (e) {
    // Only a MISSING main file is grounds for a restore. A transient read
    // failure (a Windows EBUSY/EPERM share lock at boot) says nothing about
    // the file's contents; restoring over it used to roll the live task DB
    // back to the last merge-run snapshot.
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn(`[tasks] could not read ${src}; skipping backup restore:`, e);
      return;
    }
  }
  if (srcRaw !== null && isValidTasksJson(srcRaw)) return;
  let backupRaw: string;
  try {
    backupRaw = await fs.readFile(dst, 'utf8');
  } catch {
    return; // no backup — nothing to do
  }
  if (!isValidTasksJson(backupRaw)) return; // backup also corrupt
  try {
    if (srcRaw !== null) {
      // The corrupt main file may still hold tasks newer than the backup
      // (hand-recoverable from a truncated file): move it aside, as the
      // loader would, before replacing it. If its bytes can't be preserved
      // this throws and the restore is skipped — the loader then gets its
      // own chance to preserve or write-protect it.
      const corruptPath = `${src}.corrupt-${Date.now()}`;
      try {
        await fs.rename(src, corruptPath);
      } catch {
        await fs.writeFile(corruptPath, srcRaw, 'utf8');
      }
    }
    await fs.mkdir(path.dirname(src), { recursive: true });
    await atomicWriteFile(src, backupRaw);
    console.warn(
      `[tasks] restored ${src} from ${dst} — main file was missing or corrupt`,
    );
  } catch (e) {
    console.error(`[tasks] restore of ${src} from ${dst} failed:`, e);
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
