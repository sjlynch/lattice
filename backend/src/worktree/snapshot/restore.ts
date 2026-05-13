import path from 'node:path';
import fs from 'node:fs/promises';
import { isPathInsideRepo } from '../paths.js';
import type { SnapshotHandle } from './manifest.js';

// Restore everything in the snapshot back into the working tree. Files
// the FF brought in for paths we'd snapshotted will be overwritten by the
// user's snapshotted version — this is intentional (see module header).
//
// On success the snapshot dir is removed. On any copy failure it stays so
// the user can recover from disk.
export async function restoreSnapshot(
  handle: SnapshotHandle,
  repoRoot: string,
): Promise<void> {
  if (!handle.dir) return;
  const all = [...handle.modifiedTracked, ...handle.untracked];
  // Path safety gate: the manifest is JSON on disk that may have been
  // written by an older Lattice build (without path validation), corrupted,
  // or tampered with. A bad entry — `..\..\.git\HEAD`, an absolute path,
  // a Windows drive root — would have us copy attacker-controlled content
  // out of the snapshot dir and into the user's filesystem with our
  // privileges. Filter unsafe entries and refuse to write them.
  const unsafe: string[] = [];
  const safe = all.filter((f) => {
    if (isPathInsideRepo(repoRoot, f)) return true;
    unsafe.push(f);
    return false;
  });
  if (unsafe.length > 0) {
    console.error(
      `[snapshot] refused to restore ${unsafe.length} unsafe path(s) ` +
        `(escapes ${repoRoot}): ${unsafe.slice(0, 5).join(', ')}` +
        (unsafe.length > 5 ? ` (+${unsafe.length - 5} more)` : ''),
    );
  }
  let failed = unsafe.length;
  for (const file of safe) {
    const src = path.join(handle.dir, file);
    const dst = path.join(repoRoot, file);
    try {
      await fs.mkdir(path.dirname(dst), { recursive: true });
      await fs.copyFile(src, dst);
    } catch (err) {
      failed += 1;
      console.warn(
        `[snapshot] restore ${file} failed: ${(err as Error).message}`,
      );
    }
  }
  if (failed === 0) {
    try {
      await fs.rm(handle.dir, { recursive: true, force: true });
    } catch {
      /* dir cleanup failure isn't fatal */
    }
  } else {
    console.warn(
      `[snapshot] ${failed} of ${all.length} file(s) failed to restore; ` +
        `snapshot kept at ${handle.dir} for manual recovery`,
    );
  }
}

// Drop a snapshot without restoring (caller decided the snapshot is
// no longer relevant — e.g. the FF failed and was rolled back through a
// different path).
export async function discardSnapshot(handle: SnapshotHandle): Promise<void> {
  if (!handle.dir) return;
  try {
    await fs.rm(handle.dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}
