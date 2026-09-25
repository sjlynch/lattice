import path from 'node:path';
import fs from 'node:fs/promises';
import { projectGit } from '../projectGit.js';
import { projectHash } from '../../projectPath.js';
import { withProjectMutation } from '../../projectRunLock.js';
import { formatBytes, freeBytesAt, minFreeDiskBytes } from '../diskSpace.js';
import { assertNotReparsePoint } from '../cleanupSafety.js';
import { currentProjectMutationOwner } from '../../projectRunLock/mutation.js';
import {
  EMPTY_HANDLE,
  SNAPSHOTS_BASE,
  isCommitId,
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
  unstageAddedSnapshotPaths,
  restoreDeletedSnapshotPaths,
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
  unstageAddedSnapshotPaths,
  restoreDeletedSnapshotPaths,
  cleanupCapturedUntrackedPaths,
} from './copyAndCleanup.js';

// See pathClassification.ts for what each bucket means and why `added` /
// `deleted` are not folded into `modified`. The two newer buckets are optional
// on INPUT so hand-built inputs (tests, older callers) keep working; the
// parser always emits all four.
export type DirtyPaths = {
  modified: string[];
  untracked: string[];
  added?: string[];
  deleted?: string[];
};

export type SafeDirtyPaths = Required<DirtyPaths> & {
  dropped: string[];
};

export type SnapshotCopyResult = {
  copiedModified: string[];
  copiedUntracked: string[];
  copiedAdded: string[];
  copyFailures: string[];
};

export type SnapshotCleanupPlan = {
  resetTracked: string[];
  deleteUntracked: string[];
  unstageAdded: string[];
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
  deleted: string[] = [],
  baseCommit?: string,
): Promise<void> {
  // Manifest written AFTER copies so it reflects what was actually
  // captured. recoverPendingSnapshots reads this on boot — if a file isn't
  // listed, it won't be restored (correctly: we never copied it).
  //
  // A staged-new (`added`) path is listed under `untracked`: restore puts it
  // back as a plain file either way (the staging is not preserved, same as a
  // staged modification comes back unstaged). `deleted` paths have no copy —
  // they are listed BEFORE the `checkout HEAD` that resurrects them, so a
  // crash in between leaves a manifest whose restore is a no-op for a path
  // that is still absent, and a correct re-deletion for one that came back.
  await writeSnapshotManifest(snapshotDir, {
    version: 1,
    repoRoot,
    label,
    createdAt: Date.now(),
    modifiedTracked: copies.copiedModified,
    untracked: [...copies.copiedUntracked, ...copies.copiedAdded],
    ...(deleted.length > 0 ? { deleted: [...deleted] } : {}),
    ...(baseCommit ? { baseCommit } : {}),
    owner: currentProjectMutationOwner(repoRoot),
  });
}

export function buildSnapshotCleanupPlan(
  copies: SnapshotCopyResult,
): SnapshotCleanupPlan {
  return {
    resetTracked: [...copies.copiedModified],
    deleteUntracked: [...copies.copiedUntracked],
    unstageAdded: [...(copies.copiedAdded ?? [])],
  };
}

export type SnapshotScope = {
  // Capture only dirty paths that collide with these repo-relative paths
  // (equal, or one an ancestor directory of the other). A fast-forward only
  // rewrites the paths that differ between HEAD and its target, and git
  // refuses — without writing — when anything else would be clobbered, so a
  // dirty path outside that set is never at risk. Unscoped, a large dirty
  // tree was copied in full for every fast-forward (~1 GB each, 2026-09-23).
  onlyPaths?: readonly string[];
};

// Snapshot every dirty path in `repoRoot` (or, with `scope.onlyPaths`, only
// the ones that collide with those paths) and reset them in the working tree.
// `label` becomes part of the snapshot dir name — use 'run' for the
// run-level snapshot, 'fastfwd-<branch>' for per-FF snapshots, etc.
//
// The capture ORDER is safety-critical (.git-deletion defences — see
// snapshot/CLAUDE.md): parse status -> filter to repo-contained paths ->
// scope -> free-space check -> create dir + copy (recording
// successes/failures) -> write manifest of the copied paths -> reset tracked /
// delete untracked ONLY for successfully copied paths. A failed copy stays
// dirty in the working tree so a later git op fails safely rather than losing
// the user's uncommitted data.
export async function snapshotWorkingTree(
  repoRoot: string,
  label: string,
  scope: SnapshotScope = {},
): Promise<SnapshotHandle> {
  return withProjectMutation(repoRoot, () => captureWorkingTree(repoRoot, label, scope));
}

function scopePredicate(onlyPaths: readonly string[]): (p: string) => boolean {
  const norm = (p: string) => {
    const s = p.replace(/\\/g, '/').replace(/\/+$/, '');
    return process.platform === 'win32' ? s.toLowerCase() : s;
  };
  const exact = new Set<string>();
  const ancestors = new Set<string>();
  for (const raw of onlyPaths) {
    const p = norm(raw);
    exact.add(p);
    for (let i = p.indexOf('/'); i !== -1; i = p.indexOf('/', i + 1)) ancestors.add(p.slice(0, i));
  }
  return (raw) => {
    const p = norm(raw);
    if (exact.has(p) || ancestors.has(p)) return true;
    for (let i = p.indexOf('/'); i !== -1; i = p.indexOf('/', i + 1)) {
      if (exact.has(p.slice(0, i))) return true;
    }
    return false;
  };
}

async function removePartialSnapshotDir(dir: string): Promise<void> {
  const base = path.resolve(SNAPSHOTS_BASE);
  const target = path.resolve(dir);
  if (!target.startsWith(base + path.sep)) return;
  try {
    await assertNotReparsePoint(target);
    await fs.rm(target, { recursive: true, force: true });
  } catch (err) {
    console.warn(`[snapshot] could not remove partial snapshot ${target}:`, err);
  }
}

// Bytes the capture would copy. Symlinks and vanished paths count as zero.
async function capturedBytes(repoRoot: string, paths: string[]): Promise<number> {
  let total = 0;
  for (const rel of paths) {
    try {
      const st = await fs.lstat(path.join(repoRoot, rel));
      if (st.isFile()) total += st.size;
    } catch {
      /* gone — nothing to copy */
    }
  }
  return total;
}

async function captureWorkingTree(
  repoRoot: string,
  label: string,
  scope: SnapshotScope,
): Promise<SnapshotHandle> {
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

  const all = classifySafeDirtyPaths(repoRoot, status.stdout);
  logDroppedPaths(repoRoot, all.dropped);
  const inScope = scope.onlyPaths ? scopePredicate(scope.onlyPaths) : () => true;
  const dirty = {
    ...all,
    modified: all.modified.filter(inScope),
    untracked: all.untracked.filter(inScope),
    added: all.added.filter(inScope),
    deleted: all.deleted.filter(inScope),
  };
  if (
    dirty.modified.length === 0 && dirty.untracked.length === 0 &&
    dirty.added.length === 0 && dirty.deleted.length === 0
  ) return EMPTY_HANDLE;

  // Refuse BEFORE copying anything when the copy would push the disk below
  // the free-space reserve: nothing has been copied or reset yet, so the
  // caller's operation fails with the user's tree untouched, instead of
  // failing mid-copy on ENOSPC with half a snapshot on disk.
  const bytes = await capturedBytes(repoRoot, [...dirty.modified, ...dirty.untracked, ...dirty.added]);
  const snapshotsRoot = SNAPSHOTS_BASE;
  const free = await freeBytesAt(snapshotsRoot);
  const reserve = await minFreeDiskBytes();
  if (free !== null && free - bytes < reserve) {
    throw new Error(
      `not enough disk space to snapshot ${formatBytes(bytes)} of uncommitted changes in ${repoRoot} ` +
        `(${formatBytes(free)} free, ${formatBytes(reserve)} kept in reserve) — ` +
        'nothing was changed; commit or clean up the working tree, or free disk space, then retry',
    );
  }

  // The commit the captured edits sit on: restore three-way merges a path a
  // later fast-forward rewrote against it instead of overlaying the captured
  // copy over the merged change (restore.ts). Unknown on an unborn HEAD.
  const baseCommit = await readHeadCommit(repoRoot);
  const dir = await createSnapshotDirectory(repoRoot, label);
  let copies: SnapshotCopyResult;
  try {
    copies = await copyDirtyPathsToSnapshot(repoRoot, dir, dirty);
    logCopyFailures(copies.copyFailures);
    await writeCapturedSnapshotManifest(repoRoot, label, dir, copies, dirty.deleted, baseCommit);
  } catch (err) {
    // No manifest means nothing in the working tree was reset or deleted yet
    // (that happens only after it), and recovery ignores a manifest-less
    // dir — so this partial copy is pure waste. Remove it rather than leave
    // it orphaned (a failed capture under ENOSPC used to strand hundreds of
    // MB each time). `dir` came from mkdtemp under SNAPSHOTS_BASE.
    await removePartialSnapshotDir(dir);
    throw err;
  }

  const cleanupPlan = buildSnapshotCleanupPlan(copies);
  await resetTrackedSnapshotPaths(repoRoot, cleanupPlan.resetTracked, dir);
  await unstageAddedSnapshotPaths(repoRoot, cleanupPlan.unstageAdded, dir);
  await cleanupCapturedUntrackedPaths(repoRoot, cleanupPlan.deleteUntracked, dir);
  await restoreDeletedSnapshotPaths(repoRoot, dirty.deleted);

  return {
    dir,
    modifiedTracked: cleanupPlan.resetTracked,
    untracked: [...cleanupPlan.deleteUntracked, ...cleanupPlan.unstageAdded],
    deleted: [...dirty.deleted],
    ...(baseCommit ? { baseCommit } : {}),
  };
}

async function readHeadCommit(repoRoot: string): Promise<string | undefined> {
  const head = await projectGit(repoRoot, ['rev-parse', '--verify', '--quiet', 'HEAD']);
  const sha = head.stdout.trim();
  return head.code === 0 && isCommitId(sha) ? sha : undefined;
}
