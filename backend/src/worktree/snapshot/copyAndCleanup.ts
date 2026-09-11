import path from 'node:path';
import fs from 'node:fs/promises';
import { projectGit } from '../projectGit.js';
import type { DirtyPaths, SnapshotCopyResult } from './capture.js';
import { isPathInsideRepo } from '../paths.js';
import { isSnapshotMetadataPath } from './manifest.js';
import { pathVersion } from './versions.js';

async function assertNoSymlinkParents(root: string, file: string): Promise<void> {
  const parts = file.split(/[\\/]+/).filter(Boolean);
  let current = root;
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
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
  }
}

async function copySnapshotPath(
  repoRoot: string,
  snapshotDir: string,
  file: string,
): Promise<boolean> {
  const src = path.join(repoRoot, file);
  const dst = path.join(snapshotDir, file);
  try {
    // Payloads share the snapshot root with its manifest. Leave a colliding
    // repository path untouched rather than replace its backup with metadata.
    if (isSnapshotMetadataPath(file)) throw new Error('path reserved for snapshot metadata');
    await assertNoSymlinkParents(repoRoot, file);
    const stat = await fs.lstat(src);
    if (!stat.isFile() && !stat.isSymbolicLink()) {
      throw new Error('not a regular file or symlink');
    }
    await fs.mkdir(path.dirname(dst), { recursive: true });
    if (stat.isSymbolicLink()) {
      // Preserve the link itself. `copyFile` follows symlinks, which would
      // leak outside-repo file contents when a dirty repo symlink targets a
      // path elsewhere on disk, and restore would turn the link into a file.
      const target = await fs.readlink(src);
      await fs.symlink(target, dst);
    } else {
      await fs.copyFile(src, dst);
    }
    return true;
  } catch (err) {
    console.warn(
      `[snapshot] copy ${file} failed: ${(err as Error).message}`,
    );
    return false;
  }
}

export async function copyDirtyPathsToSnapshot(
  repoRoot: string,
  snapshotDir: string,
  dirty: DirtyPaths,
): Promise<SnapshotCopyResult> {
  // Copy each path and track which succeeded. We only reset / delete the
  // working-tree copy of files we successfully captured — otherwise a
  // transient I/O error during copy would silently lose the user's
  // uncommitted edits when the subsequent reset overwrote them.
  const copiedModified: string[] = [];
  const copiedUntracked: string[] = [];
  const copyFailures: string[] = [];
  for (const [files, target] of [
    [dirty.modified, copiedModified] as const,
    [dirty.untracked, copiedUntracked] as const,
  ]) {
    for (const file of files) {
      if (await copySnapshotPath(repoRoot, snapshotDir, file)) {
        target.push(file);
      } else {
        copyFailures.push(file);
      }
    }
  }
  return { copiedModified, copiedUntracked, copyFailures };
}

export function logCopyFailures(copyFailures: string[]): void {
  if (copyFailures.length === 0) return;
  console.warn(
    `[snapshot] ${copyFailures.length} file(s) failed to copy and will ` +
      `NOT be reset/deleted from the working tree (preserves user data): ` +
      copyFailures.slice(0, 5).join(', ') +
      (copyFailures.length > 5 ? ` (+${copyFailures.length - 5} more)` : ''),
  );
}

export async function resetTrackedSnapshotPaths(
  repoRoot: string,
  resetTracked: string[],
  snapshotDir?: string,
): Promise<void> {
  // Reset modified tracked files — but only the ones whose snapshot copy
  // succeeded. Resetting a file we failed to copy would replace the user's
  // uncommitted changes with HEAD's version and lose them irretrievably.
  // A file we failed to copy stays dirty in the working tree; the FF that
  // follows will fail with a clear error, the caller restores any partial
  // snapshot, and the user's data is intact.
  resetTracked = await unchangedSinceCopy(repoRoot, resetTracked, snapshotDir);
  if (resetTracked.length === 0) return;
  const co = await projectGit(repoRoot, ['checkout', 'HEAD', '--', ...resetTracked.map((file) => `:(literal)${file}`)]);
  if (co.code !== 0) {
    console.warn(
      `[snapshot] git checkout HEAD -- (${resetTracked.length} files) ` +
        `exit ${co.code}: ${co.stderr.trim() || co.stdout.trim()}`,
    );
  }
}

export async function cleanupCapturedUntrackedPaths(
  repoRoot: string,
  deleteUntracked: string[],
  snapshotDir?: string,
): Promise<void> {
  // Delete only untracked files we successfully captured. Same rationale:
  // if the copy failed we leave the file alone rather than risk losing it.
  for (const file of deleteUntracked) {
    try {
      if (!isPathInsideRepo(repoRoot, file)) continue;
      await assertNoSymlinkParents(repoRoot, file);
      if (!(await unchangedSinceCopy(repoRoot, [file], snapshotDir)).length) continue;
      // Capture accepts files and links only. A directory here appeared AFTER
      // capture and contains unsnapshotted work; never recursively remove it.
      await fs.rm(path.join(repoRoot, file), { force: true, recursive: false });
    } catch {
      /* ignore */
    }
  }
}

async function unchangedSinceCopy(repoRoot: string, files: string[], snapshotDir?: string): Promise<string[]> {
  if (!snapshotDir) return []; // No captured version to compare: refuse cleanup.
  const unchanged: string[] = [];
  for (const file of files) {
    if (!isPathInsideRepo(repoRoot, file) || isSnapshotMetadataPath(file)) continue;
    try {
      await assertNoSymlinkParents(repoRoot, file);
      await assertNoSymlinkParents(snapshotDir, file);
      const [current, copied] = await Promise.all([
        pathVersion(path.join(repoRoot, file)),
        pathVersion(path.join(snapshotDir, file)),
      ]);
      if (copied !== null && current === copied) { unchanged.push(file); continue; }
      console.warn(`[snapshot] ${file} changed after capture; leaving the newer working-tree version in place`);
    } catch (err) {
      console.warn(`[snapshot] cannot verify ${file} before cleanup; leaving it in place: ${(err as Error).message}`);
    }
  }
  return unchanged;
}
