import path from 'node:path';
import {
  homeProjectDir as sharedHomeProjectDir,
  latticeHomeDir,
} from '../projectPath.js';

export const LATTICE_HOME = latticeHomeDir();
export const PROJECTS_INDEX = path.join(LATTICE_HOME, 'projects.json');
export const LEGACY_GLOBAL_TASKS = path.join(LATTICE_HOME, 'tasks.json');
export const PER_PROJECT_BASE = path.join(LATTICE_HOME, 'per-project');

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
export function homeProjectDir(projectPath: string): string {
  return sharedHomeProjectDir(projectPath);
}

export function projectTasksFile(projectPath: string): string {
  return path.join(homeProjectDir(projectPath), PROJECT_TASKS_FILENAME);
}

export function projectTasksBackupFile(projectPath: string): string {
  return path.join(homeProjectDir(projectPath), PROJECT_TASKS_BACKUP_FILENAME);
}
