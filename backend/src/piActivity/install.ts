// Filesystem installation and project-mode removal for Pi activity reporting.
// Rendering and the managed filename live in sibling modules.

import path from 'node:path';
import fs from 'node:fs/promises';
import { atomicWriteFile } from '../claudeTrust/configFile.js';
import { PI_ACTIVITY_EXTENSION_FILE } from './constants.js';
import { renderPiActivityExtension } from './template.js';

// Write (or refresh) `<dir>/.pi/extensions/lattice-activity.ts`. Skips the
// write when the file already matches, so reconciling a worktree against the
// same task doesn't dirty `git status` (the file is excluded anyway — see
// worktree/managedFiles.ts). Best-effort: activity reporting is cosmetic, so a
// failure is logged and never fails the spawn.
export async function installPiActivityExtension(args: {
  dir: string;
  activityUrl: string;
  projectSession?: boolean;
}): Promise<void> {
  const file = piActivityExtensionPath(args.dir);
  const expected = renderPiActivityExtension(args.activityUrl, {
    projectSession: args.projectSession,
  });
  try {
    try {
      if ((await fs.readFile(file, 'utf8')) === expected) return;
    } catch {
      /* absent — write it */
    }
    await fs.mkdir(path.dirname(file), { recursive: true });
    await atomicWriteFile(file, expected);
  } catch (err) {
    console.warn(`[pi-activity] could not install ${file}:`, err);
  }
}

function piActivityExtensionPath(dir: string): string {
  return path.join(dir, '.pi', 'extensions', PI_ACTIVITY_EXTENSION_FILE);
}

// Remove a project-mode extension from `<dir>` (the instrumentation opt-out).
// Only a file that targets the project-activity route is deleted, so nothing
// else by that name is ever touched. Best-effort.
export async function removeProjectPiActivityExtension(dir: string): Promise<void> {
  const file = piActivityExtensionPath(dir);
  try {
    if (!(await fs.readFile(file, 'utf8')).includes('/api/project-activity/')) return;
    await fs.unlink(file);
  } catch {
    /* absent or unreadable — nothing to remove */
  }
}
