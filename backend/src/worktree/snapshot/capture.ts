import path from 'node:path';
import fs from 'node:fs/promises';
import { projectGit } from '../projectGit.js';
import { projectHash } from '../../projectPath.js';
import { withProjectMutation } from '../../projectRunLock.js';
import {
  EMPTY_HANDLE,
  SNAPSHOTS_BASE,
  writeSnapshotManifest,
  type SnapshotHandle,
} from './manifest.js';
import {
  classifySafeDirtyPaths,
  logDroppedPaths,
} from './pathClassification.js';
import {
  copyDirtyPathsToSnapshot,
  logCopyFailures,
  resetTrackedSnapshotPaths,
  cleanupCapturedUntrackedPaths,
} from './copyAndCleanup.js';

// Path-classification helpers (status parse + repo-containment filter) live in
// `pathClassification.ts`; the snapshot copy I/O and reset/delete helpers live
// in `copyAndCleanup.ts`. Re-exported here so the module's public surface — and
// the `./capture.js` import path the tests use — stays stable.
export {
  parseStatus,
  filterSafeDirtyPaths,
  classifySafeDirtyPaths,
} from './pathClassification.js';
export {
  copyDirtyPathsToSnapshot,
  resetTrackedSnapshotPaths,
  cleanupCapturedUntrackedPaths,
} from './copyAndCleanup.js';

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

export async function createSnapshotDirectory(
  repoRoot: string,
  label: string,
): Promise<string> {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const safeLabel = label.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64);
  const parent = path.join(SNAPSHOTS_BASE, projectHash(repoRoot));
  await fs.mkdir(parent, { recursive: true });
  return fs.mkdtemp(path.join(parent, `${ts}-${safeLabel}-`));
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

// Snapshot every dirty path in `repoRoot` and reset the working tree.
// `label` becomes part of the snapshot dir name — use 'run' for the
// run-level snapshot, 'fastfwd-<branch>' for per-FF snapshots, etc.
//
// The capture ORDER is safety-critical (.git-deletion defences — see
// snapshot/CLAUDE.md): parse status -> filter to repo-contained paths ->
// create dir + copy (recording successes/failures) -> write manifest of the
// copied paths -> reset tracked / delete untracked ONLY for successfully
// copied paths. A failed copy stays dirty in the working tree so a later git
// op fails safely rather than losing the user's uncommitted data.
export async function snapshotWorkingTree(
  repoRoot: string,
  label: string,
): Promise<SnapshotHandle> {
  return withProjectMutation(repoRoot, () => captureWorkingTree(repoRoot, label));
}

async function captureWorkingTree(repoRoot: string, label: string): Promise<SnapshotHandle> {
  const status = await projectGit(repoRoot, [
    'status',
    '--porcelain=v1',
    '-z', // NUL-delimited, verbatim paths, no rename arrow — see parseStatus
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
