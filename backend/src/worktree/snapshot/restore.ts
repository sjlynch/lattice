import path from 'node:path';
import fs from 'node:fs/promises';
import { withProjectMutation } from '../../projectRunLock.js';
import { constants, type Stats } from 'node:fs';
import { isPathInsideRepo } from '../paths.js';
import { isSnapshotMetadataPath, SNAPSHOTS_BASE, type SnapshotHandle } from './manifest.js';
import { assertNotReparsePoint } from '../cleanupSafety.js';
import { projectGit } from '../projectGit.js';
import { pathVersion } from './versions.js';

// Suffix for the copy we leave beside a path whose on-disk content diverged
// from the snapshot when the stale-overwrite guard is engaged (boot recovery).
// Rather than clobber the newer on-disk file, we drop the snapshot's captured
// version at `<path><this suffix>` and keep the original in place.
export const SNAPSHOT_CONFLICT_SUFFIX = '.lattice-conflict';

// Thrown by restoreSnapshotPath (only under the stale-overwrite guard) when a
// path's on-disk content differs from what the snapshot captured. It is NOT a
// failure to write — the captured version has already been backed up beside
// the on-disk file — but restoreSnapshot treats it like one so the snapshot
// dir is retained for the user to reconcile.
export class StaleSnapshotConflict extends Error {
  constructor(
    readonly file: string,
    readonly backupPath: string,
  ) {
    super(`on-disk ${file} changed since capture; kept it, backed up snapshot copy to ${backupPath}`);
    this.name = 'StaleSnapshotConflict';
  }
}

// Options controlling how the snapshot is written back into the working tree.
export type RestoreSnapshotOptions = {
  // Default: preserve differing dirty/untracked destinations; overlay only a
  // tracked destination verified clean against HEAD. True (boot recovery):
  // preserve ANY differing destination. False explicitly opts into overwrite
  // for callers that independently own and verified the destination.
  guardStaleOverwrite?: boolean;
};

export type SnapshotRestoreResult = {
  status: 'restored' | 'partial';
  restored: string[];
  conflicts: { file: string; backupPath: string }[];
  failed: { file: string; message: string }[];
  retained: boolean;
};

// Only committed, clean tracked content may be replaced in-session. A dirty
// destination represents work performed after capture and must be retained.
async function cleanTrackedVersion(repoRoot: string, file: string, dst: string): Promise<boolean> {
  try {
    const before = await pathVersion(dst);
    const literal = `:(literal)${file}`;
    const tracked = await projectGit(repoRoot, ['ls-files', '-v', '-z', '--error-unmatch', '--', literal]);
    // Skip-worktree/assume-unchanged entries can hide edits from git diff.
    if (tracked.code !== 0 || !tracked.stdout.startsWith('H ')) return false;
    const diff = await projectGit(repoRoot, ['diff', '--quiet', 'HEAD', '--', literal]);
    return diff.code === 0 && before === await pathVersion(dst);
  } catch { return false; }
}

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

// Stale-overwrite guard: does the current on-disk file at `dst` diverge from
// the snapshot's captured version at `src`? A missing `dst` does NOT diverge
// (there's nothing to clobber — restore it cleanly). Any type mismatch
// (symlink vs regular file, directory where a file was captured) counts as
// divergence, as does differing content / link target.
async function onDiskDivergesFromCapture(
  src: string,
  dst: string,
  srcStat: Stats,
): Promise<boolean> {
  let dstStat: Stats;
  try {
    dstStat = await fs.lstat(dst);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
  if (srcStat.isSymbolicLink()) {
    if (!dstStat.isSymbolicLink()) return true;
    const [a, b] = await Promise.all([fs.readlink(src), fs.readlink(dst)]);
    return a !== b;
  }
  if (!dstStat.isFile()) return true;
  const [a, b] = await Promise.all([pathVersion(src), pathVersion(dst)]);
  return a !== b;
}

// Copy the snapshot's captured version to `<dst>.lattice-conflict` instead of
// overwriting the (newer) on-disk file. Returns the backup path.
async function backupCapturedVersionBesideDst(
  src: string,
  dst: string,
  srcStat: Stats,
): Promise<string> {
  for (let suffix = 0; suffix < 1000; suffix += 1) {
    const backup = dst + SNAPSHOT_CONFLICT_SUFFIX + (suffix ? `.${suffix}` : '');
    try {
      // Exclusive creation preserves an earlier snapshot or a user's edits
      // to its recovery copy, including a racing writer at the same path.
      if (srcStat.isSymbolicLink()) {
        await fs.symlink(await fs.readlink(src), backup);
      } else {
        await fs.copyFile(src, backup, constants.COPYFILE_EXCL);
      }
      return backup;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      // A retained snapshot is visited on every boot. Reuse a byte-identical
      // copy so recovery doesn't create a new sibling on every restart.
      if (!(await onDiskDivergesFromCapture(src, backup, srcStat))) return backup;
    }
  }
  throw new Error('too many existing snapshot conflict copies');
}

async function restoreSnapshotPath(
  snapshotDir: string,
  repoRoot: string,
  file: string,
  opts: RestoreSnapshotOptions,
): Promise<void> {
  const src = path.join(snapshotDir, file);
  const dst = path.join(repoRoot, file);
  await assertNoSymlinkParents(snapshotDir, file);
  const stat = await fs.lstat(src);
  if (!stat.isFile() && !stat.isSymbolicLink()) {
    throw new Error('snapshot source is not a regular file or symlink');
  }
  await ensureSafeParentDirectory(repoRoot, file);
  const [sourceVersion, destinationVersion] = await Promise.all([pathVersion(src), pathVersion(dst)]);
  const destinationExists = destinationVersion !== null;
  const diverged = destinationExists && sourceVersion !== destinationVersion;
  if (!diverged && destinationExists) return; // Already restored; avoid watcher churn.
  if (opts.guardStaleOverwrite !== false && diverged &&
      (opts.guardStaleOverwrite === true || !(await cleanTrackedVersion(repoRoot, file, dst)))) {
    // The working tree changed since capture. We cannot tell an intended FF
    // from the user re-doing their edits after a cancelled run, so preserve
    // what's on disk and drop the snapshot's version alongside it for review.
    const backup = await backupCapturedVersionBesideDst(src, dst, stat);
    throw new StaleSnapshotConflict(file, backup);
  }
  if (destinationExists) await removeExistingPathNoFollow(dst);
  if (stat.isSymbolicLink()) {
    const target = await fs.readlink(src);
    await fs.symlink(target, dst);
  } else {
    await fs.copyFile(src, dst, constants.COPYFILE_EXCL);
  }
}

// Re-apply a deletion the snapshot captured (the path was locally deleted; the
// capture resurrected HEAD's copy so the FF could run). There is no captured
// content to compare against, so the rule is the same in both modes: delete
// only a tracked file that is byte-identical to HEAD (recoverable with one
// `git checkout` if the user disagrees). Anything else — an edited file, an
// untracked replacement, a directory — is newer work and is kept; the throw
// makes restoreSnapshot report it and retain the snapshot dir.
async function reapplySnapshotDeletion(repoRoot: string, file: string): Promise<void> {
  const dst = path.join(repoRoot, file);
  await assertNoSymlinkParents(repoRoot, file);
  let stat: Stats;
  try {
    stat = await fs.lstat(dst);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return; // still deleted
    throw err;
  }
  if (stat.isDirectory()) {
    throw new Error('a directory now exists at the captured deletion; keeping it');
  }
  if (!(await cleanTrackedVersion(repoRoot, file, dst))) {
    throw new Error('on-disk content differs from HEAD; keeping it instead of re-deleting');
  }
  await fs.rm(dst, { force: true, recursive: false });
}

// Restore captured work, preserving divergent dirty destinations. Immediate
// restoration can overlay clean committed HEAD; boot recovery is stricter.
//
// On success the snapshot dir is removed. On any copy failure — or, under the
// stale-overwrite guard, any path that diverged on disk and was backed up to a
// `.lattice-conflict` copy — it stays so the user can recover from disk.
export async function restoreSnapshot(
  handle: SnapshotHandle,
  repoRoot: string,
  opts: RestoreSnapshotOptions = {},
): Promise<SnapshotRestoreResult> {
  if (!handle.dir) return { status: 'restored', restored: [], conflicts: [], failed: [], retained: false };
  return withProjectMutation(repoRoot, () => restoreOwnedSnapshot(handle, repoRoot, opts));
}

async function restoreOwnedSnapshot(handle: SnapshotHandle, repoRoot: string, opts: RestoreSnapshotOptions): Promise<SnapshotRestoreResult> {
  const result: SnapshotRestoreResult = { status: 'restored', restored: [], conflicts: [], failed: [], retained: false };
  const copied = [...handle.modifiedTracked, ...handle.untracked];
  // A path with a captured copy is restored from it; only a path that has NO
  // copy is treated as a captured deletion.
  const copiedSet = new Set(copied);
  const deletions = new Set((handle.deleted ?? []).filter((f) => !copiedSet.has(f)));
  const all = [...copied, ...deletions];
  // Path safety gate: the manifest is JSON on disk that may have been
  // written by an older Lattice build (without path validation), corrupted,
  // or tampered with. A bad entry — `..\..\.git\HEAD`, an absolute path,
  // a Windows drive root, or the in-repo `.git/HEAD` form — would have us copy
  // attacker-controlled content out of the snapshot dir and into the user's
  // filesystem (or straight onto the gitdir) with our privileges. Filter
  // unsafe entries and refuse to write them.
  const unsafe: string[] = [];
  const safe = all.filter((f) => {
    if (isPathInsideRepo(repoRoot, f) && !isSnapshotMetadataPath(f)) return true;
    unsafe.push(f);
    return false;
  });
  if (unsafe.length > 0) {
    console.error(
      `[snapshot] refused to restore ${unsafe.length} unsafe path(s) ` +
        `(escape ${repoRoot} or target a reserved dir like .git): ` +
        `${unsafe.slice(0, 5).join(', ')}` +
        (unsafe.length > 5 ? ` (+${unsafe.length - 5} more)` : ''),
    );
  }
  let failed = unsafe.length;
  result.failed.push(...unsafe.map((file) => ({ file, message: 'unsafe snapshot path' })));
  let staleConflicts = 0;
  for (const file of safe) {
    try {
      if (deletions.has(file)) await reapplySnapshotDeletion(repoRoot, file);
      else await restoreSnapshotPath(handle.dir, repoRoot, file, opts);
      result.restored.push(file);
    } catch (err) {
      failed += 1;
      if (err instanceof StaleSnapshotConflict) {
        staleConflicts += 1;
        result.conflicts.push({ file, backupPath: err.backupPath });
        console.warn(`[snapshot] ${err.message}`);
      } else {
        result.failed.push({ file, message: (err as Error).message });
        console.warn(
          `[snapshot] restore ${file} failed: ${(err as Error).message}`,
        );
      }
    }
  }
  if (failed === 0) {
    try {
      await assertSnapshotRemovalSafe(handle.dir, repoRoot);
      await fs.rm(handle.dir, { recursive: true, force: true });
    } catch {
      result.retained = true;
    }
  } else {
    result.status = 'partial';
    result.retained = true;
    console.warn(
      `[snapshot] ${failed} of ${all.length} file(s) not restored` +
        (staleConflicts > 0
          ? ` (${staleConflicts} changed on disk since capture — ` +
            `snapshot copies left as ${SNAPSHOT_CONFLICT_SUFFIX} files)`
          : '') +
        `; snapshot kept at ${handle.dir} for manual recovery`,
    );
  }
  return result;
}

// Drop a snapshot without restoring (caller decided the snapshot is
// no longer relevant — e.g. the FF failed and was rolled back through a
// different path).
export async function discardSnapshot(handle: SnapshotHandle): Promise<void> {
  if (!handle.dir) return;
  try {
    const relative = path.relative(path.resolve(SNAPSHOTS_BASE), path.resolve(handle.dir));
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('snapshot outside the managed snapshot root');
    await assertNotReparsePoint(handle.dir);
    await fs.rm(handle.dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

async function assertSnapshotRemovalSafe(snapshotDir: string, repoRoot: string): Promise<void> {
  const snapshot = path.resolve(snapshotDir);
  const repo = path.resolve(repoRoot);
  const relative = path.relative(snapshot, repo);
  if (!relative || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
    throw new Error('refusing to remove a snapshot directory containing the project');
  }
  const insideRepo = path.relative(repo, snapshot);
  if (!insideRepo.startsWith('..') && !path.isAbsolute(insideRepo)) throw new Error('refusing to remove a snapshot directory inside the project');
  if (snapshot === path.parse(snapshot).root) throw new Error('refusing to remove a filesystem root');
  await assertNotReparsePoint(snapshot);
}
