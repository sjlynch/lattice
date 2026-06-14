import path from 'node:path';
import fs from 'node:fs/promises';
import { projectGit } from '../projectGit.js';
import type { DirtyPaths, SnapshotCopyResult } from './capture.js';

async function copySnapshotPath(
  repoRoot: string,
  snapshotDir: string,
  file: string,
): Promise<boolean> {
  const src = path.join(repoRoot, file);
  const dst = path.join(snapshotDir, file);
  try {
    await fs.mkdir(path.dirname(dst), { recursive: true });
    await fs.copyFile(src, dst);
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
): Promise<void> {
  // Reset modified tracked files — but only the ones whose snapshot copy
  // succeeded. Resetting a file we failed to copy would replace the user's
  // uncommitted changes with HEAD's version and lose them irretrievably.
  // A file we failed to copy stays dirty in the working tree; the FF that
  // follows will fail with a clear error, the caller restores any partial
  // snapshot, and the user's data is intact.
  if (resetTracked.length === 0) return;
  const co = await projectGit(repoRoot, ['checkout', 'HEAD', '--', ...resetTracked]);
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
): Promise<void> {
  // Delete only untracked files we successfully captured. Same rationale:
  // if the copy failed we leave the file alone rather than risk losing it.
  for (const file of deleteUntracked) {
    try {
      await fs.rm(path.join(repoRoot, file), { force: true, recursive: true });
    } catch {
      /* ignore */
    }
  }
}
