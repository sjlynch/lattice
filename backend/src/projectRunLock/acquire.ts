import fs from 'node:fs/promises';
import path from 'node:path';
import { currentLockBody } from './liveness.js';
import { writeNewLockBody } from './lockfile.js';
import { projectRunLockFilePath } from './paths.js';
import { releaseLockFile } from './release.js';
import { clearStaleLockOrThrow } from './steal.js';
import type { ProjectRunLockHandle } from './types.js';
import { registerProjectRunLock } from './mutation.js';

// Acquire the per-project run lock or throw. `label` is logged into the
// lockfile so a developer inspecting `~/.lattice/per-project/<hash>/run.lock`
// can tell what's holding it (e.g. `merge-run`, `manual-merge`).
export async function acquireProjectRunLock(
  projectPath: string,
  label: string,
): Promise<ProjectRunLockHandle> {
  const file = projectRunLockFilePath(projectPath);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const body = currentLockBody(label);

  // Two attempts: first try, and if EEXIST + the holder is dead (or the
  // lockfile is unparseable), steal and retry. Beyond that we surface the
  // error so the caller can fail the request — better than spinning
  // indefinitely.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await writeNewLockBody(file, body);
      return registerProjectRunLock(projectPath, body, () => releaseLockFile(file, body));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      await clearStaleLockOrThrow(file);
    }
  }

  // Shouldn't reach here — the loop either returns or throws.
  throw new Error('[projectRunLock] failed to acquire after retries');
}
