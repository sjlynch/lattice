import path from 'node:path';
import fs from 'node:fs/promises';
import { projectGit } from '../projectGit.js';
import { isPathInsideRepo } from '../paths.js';
import { projectHash } from '../../projectPath.js';
import {
  EMPTY_HANDLE,
  SNAPSHOTS_BASE,
  writeSnapshotManifest,
  type SnapshotHandle,
} from './manifest.js';

export type DirtyPaths = {
  modified: string[];
  untracked: string[];
};

export type SafeDirtyPaths = DirtyPaths & {
  dropped: string[];
};

export type SnapshotCopyResult = {
  copiedModified: string[];
  copiedUntracked: string[];
  copyFailures: string[];
};

export type SnapshotCleanupPlan = {
  resetTracked: string[];
  deleteUntracked: string[];
};

// Parse `git status --porcelain=v1 -uall` output. We treat anything that
// isn't '? ?' (untracked) as 'modified' for snapshot purposes — staged,
// unstaged, deleted, type-changed all need preserving.
export function parseStatus(out: string): DirtyPaths {
  const modified: string[] = [];
  const untracked: string[] = [];
  for (const line of out.split(/\r?\n/)) {
    if (!line) continue;
    const x = line[0];
    const y = line[1];
    const file = line.slice(3);
    if (x === '?' && y === '?') {
      untracked.push(file);
    } else if (x !== ' ' || y !== ' ') {
      modified.push(file);
    }
  }
  return { modified, untracked };
}

export function filterSafeDirtyPaths(
  repoRoot: string,
  dirty: DirtyPaths,
): SafeDirtyPaths {
  // Defence in depth: filter any path that would escape repoRoot before we
  // touch it. `git status --porcelain` shouldn't produce such paths, but
  // if it ever does — corrupt index, unusual quoting, custom porcelain
  // wrapper — the snapshot copy/delete loop must not reach outside the
  // repo. A path we drop here also won't be reset/deleted, so the user's
  // working tree is left exactly as it was for that path.
  const dropped: string[] = [];
  const modified = dirty.modified.filter((f) => {
    if (isPathInsideRepo(repoRoot, f)) return true;
    dropped.push(f);
    return false;
  });
  const untracked = dirty.untracked.filter((f) => {
    if (isPathInsideRepo(repoRoot, f)) return true;
    dropped.push(f);
    return false;
  });
  return { modified, untracked, dropped };
}

export function classifySafeDirtyPaths(
  repoRoot: string,
  statusOutput: string,
): SafeDirtyPaths {
  return filterSafeDirtyPaths(repoRoot, parseStatus(statusOutput));
}

function logDroppedPaths(repoRoot: string, dropped: string[]): void {
  if (dropped.length === 0) return;
  console.error(
    `[snapshot] refused to capture ${dropped.length} path(s) outside ` +
      `${repoRoot}: ${dropped.slice(0, 5).join(', ')}` +
      (dropped.length > 5 ? ` (+${dropped.length - 5} more)` : ''),
  );
}

export async function createSnapshotDirectory(
  repoRoot: string,
  label: string,
): Promise<string> {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const safeLabel = label.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64);
  const dir = path.join(SNAPSHOTS_BASE, projectHash(repoRoot), `${ts}-${safeLabel}`);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

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

function logCopyFailures(copyFailures: string[]): void {
  if (copyFailures.length === 0) return;
  console.warn(
    `[snapshot] ${copyFailures.length} file(s) failed to copy and will ` +
      `NOT be reset/deleted from the working tree (preserves user data): ` +
      copyFailures.slice(0, 5).join(', ') +
      (copyFailures.length > 5 ? ` (+${copyFailures.length - 5} more)` : ''),
  );
}

export async function writeCapturedSnapshotManifest(
  repoRoot: string,
  label: string,
  snapshotDir: string,
  copies: SnapshotCopyResult,
): Promise<void> {
  // Manifest written AFTER copies so it reflects what was actually
  // captured. recoverPendingSnapshots reads this on boot — if a file isn't
  // listed, it won't be restored (correctly: we never copied it).
  await writeSnapshotManifest(snapshotDir, {
    version: 1,
    repoRoot,
    label,
    createdAt: Date.now(),
    modifiedTracked: copies.copiedModified,
    untracked: copies.copiedUntracked,
  });
}

export function buildSnapshotCleanupPlan(
  copies: SnapshotCopyResult,
): SnapshotCleanupPlan {
  return {
    resetTracked: [...copies.copiedModified],
    deleteUntracked: [...copies.copiedUntracked],
  };
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

// Snapshot every dirty path in `repoRoot` and reset the working tree.
// `label` becomes part of the snapshot dir name — use 'run' for the
// run-level snapshot, 'fastfwd-<branch>' for per-FF snapshots, etc.
export async function snapshotWorkingTree(
  repoRoot: string,
  label: string,
): Promise<SnapshotHandle> {
  const status = await projectGit(repoRoot, [
    'status',
    '--porcelain=v1',
    '--untracked-files=all',
  ]);
  if (status.code !== 0) {
    throw new Error(
      `[snapshot] git status failed in ${repoRoot}: ` +
        (status.stderr.trim() || status.stdout.trim() || 'unknown'),
    );
  }

  const dirty = classifySafeDirtyPaths(repoRoot, status.stdout);
  logDroppedPaths(repoRoot, dirty.dropped);
  if (dirty.modified.length === 0 && dirty.untracked.length === 0) return EMPTY_HANDLE;

  const dir = await createSnapshotDirectory(repoRoot, label);
  const copies = await copyDirtyPathsToSnapshot(repoRoot, dir, dirty);
  logCopyFailures(copies.copyFailures);
  await writeCapturedSnapshotManifest(repoRoot, label, dir, copies);

  const cleanupPlan = buildSnapshotCleanupPlan(copies);
  await resetTrackedSnapshotPaths(repoRoot, cleanupPlan.resetTracked);
  await cleanupCapturedUntrackedPaths(repoRoot, cleanupPlan.deleteUntracked);

  return {
    dir,
    modifiedTracked: cleanupPlan.resetTracked,
    untracked: cleanupPlan.deleteUntracked,
  };
}
