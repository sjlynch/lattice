import path from 'node:path';
import fs from 'node:fs/promises';
import { isPathInsideRepo } from '../paths.js';
import type { SnapshotHandle } from './manifest.js';

async function assertNoSymlinkParents(root: string, file: string): Promise<void> {
  const parts = file.split(/[\\/]+/).filter(Boolean);
  let current = root;
  for (const part of parts.slice(0, -1)) {
    current = path.join(current, part);
    try {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink()) {
        throw new Error(`snapshot parent directory is a symlink: ${current}`);
      }
      if (!stat.isDirectory()) {
        throw new Error(`snapshot parent path is not a directory: ${current}`);
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
  }
}

async function ensureSafeParentDirectory(repoRoot: string, file: string): Promise<void> {
  const parts = file.split(/[\\/]+/).filter(Boolean);
  let current = repoRoot;
  for (const part of parts.slice(0, -1)) {
    current = path.join(current, part);
    try {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink()) {
        throw new Error(`parent directory is a symlink: ${current}`);
      }
      if (!stat.isDirectory()) {
        throw new Error(`parent path is not a directory: ${current}`);
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      await fs.mkdir(current);
    }
  }
}

async function removeExistingPathNoFollow(dst: string): Promise<void> {
  try {
    await fs.rm(dst, { force: true, recursive: false });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // Directories are not valid snapshot file entries. Leave them in place and
    // let the restore fail rather than recursively deleting user data.
    if (code !== 'ENOENT') throw err;
  }
}

async function restoreSnapshotPath(
  snapshotDir: string,
  repoRoot: string,
  file: string,
): Promise<void> {
  const src = path.join(snapshotDir, file);
  const dst = path.join(repoRoot, file);
  await assertNoSymlinkParents(snapshotDir, file);
  const stat = await fs.lstat(src);
  if (!stat.isFile() && !stat.isSymbolicLink()) {
    throw new Error('snapshot source is not a regular file or symlink');
  }
  await ensureSafeParentDirectory(repoRoot, file);
  await removeExistingPathNoFollow(dst);
  if (stat.isSymbolicLink()) {
    const target = await fs.readlink(src);
    await fs.symlink(target, dst);
  } else {
    await fs.copyFile(src, dst);
  }
}

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
    try {
      await restoreSnapshotPath(handle.dir, repoRoot, file);
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
