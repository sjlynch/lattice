import fs from 'node:fs/promises';
import path from 'node:path';
import { currentLockBody } from './liveness.js';
import { writeNewLockBody } from './lockfile.js';
import { projectRunLockFilePath } from './paths.js';
import { releaseLockFile } from './release.js';
import { clearStaleLockOrThrow } from './steal.js';
import type { ProjectRunLockHandle } from './types.js';
import { registerProjectRunLock } from './ownership.js';
import { pruneRetiredTombstonesOnce } from './tombstones.js';
import { waitWhileRestartDraining } from '../restartDrain/gate.js';

// Acquire the per-project run lock or throw. `label` is logged into the
// lockfile so a developer inspecting `~/.lattice/per-project/<hash>/run.lock`
// can tell what's holding it (e.g. `merge-run`, `manual-merge`).
//
// `lendable: false` makes the hold EXCLUSIVE within this process too:
// `withProjectMutation` will not borrow it (resolver finalize / snapshot work
// waits for the release instead). Used by the workflow Run tests step, whose
// agent edits and commits on the main checkout for the whole hold.
export async function acquireProjectRunLock(
  projectPath: string,
  label: string,
  opts: { lendable?: boolean } = {},
): Promise<ProjectRunLockHandle> {
  // A backend restart is being prepared (../restartDrain/): don't START a
  // run-lock operation it would kill a second later. Waiting here — rather
  // than failing — is safe for every caller: the drain ends by TTL if no
  // restart follows, and if one does, the caller's own durable state (a
  // workflow step's checkpoint, a ready_to_merge task, the frontend's retry)
  // re-runs it on the next boot.
  await waitWhileRestartDraining();
  const file = projectRunLockFilePath(projectPath);
  await fs.mkdir(path.dirname(file), { recursive: true });
  // Housekeeping for the retirement tombstones (see tombstones.ts): first
  // acquisition per project per process, and only while no lock exists.
  await pruneRetiredTombstonesOnce(file);
  const body = currentLockBody(label);

  // Two attempts: first try, and if EEXIST + the holder is dead (or the
  // lockfile is unparseable), steal and retry. Beyond that we surface the
  // error so the caller can fail the request — better than spinning
  // indefinitely.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await writeNewLockBody(file, body);
      return registerProjectRunLock(projectPath, body, () => releaseLockFile(file, body), opts);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      await clearStaleLockOrThrow(file);
    }
  }

  // Shouldn't reach here — the loop either returns or throws.
  throw new Error('[projectRunLock] failed to acquire after retries');
}
