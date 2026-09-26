import path from 'node:path';
import fs from 'node:fs/promises';
import { constants, type Stats } from 'node:fs';
import { projectGit } from '../projectGit.js';
import { isCommitId } from './manifest.js';
import { pathVersion } from './versions.js';
import { deletedSinceCapture, reconcileWithCommittedChange } from './threeWay.js';
import {
  SNAPSHOT_CONFLICT_SUFFIX,
  SnapshotPathKept,
  StaleSnapshotConflict,
  type RestoreSnapshotOptions,
} from './restoreTypes.js';

const MAX_CONFLICT_COPY_ATTEMPTS = 1000;

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
  for (let suffix = 0; suffix < MAX_CONFLICT_COPY_ATTEMPTS; suffix += 1) {
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

export async function restoreSnapshotPath(
  snapshotDir: string,
  repoRoot: string,
  file: string,
  opts: RestoreSnapshotOptions,
  // Capture's HEAD, and whether the path was a modified TRACKED file there.
  base: { commit?: string; tracked: boolean },
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
  // In-session restore only (boot recovery keeps its stricter rules below):
  // the capture's HEAD lets a path be checked against what landed since.
  const reconcileBase = opts.guardStaleOverwrite === undefined && isCommitId(base.commit) ? base.commit : undefined;
  if (!destinationExists && reconcileBase && base.tracked && (await deletedSinceCapture(repoRoot, reconcileBase, file))) {
    // The merge deleted a file the user had modified. Putting the copy back
    // at its path would silently undo that deletion in the working tree (and
    // a later `git add -A` would commit it), so surface it as a conflict.
    const backup = await backupCapturedVersionBesideDst(src, dst, stat);
    throw new StaleSnapshotConflict(file, backup, 'deleted by the merge, but you had uncommitted edits to it');
  }
  if (opts.guardStaleOverwrite !== false && diverged &&
      (opts.guardStaleOverwrite === true || !(await cleanTrackedVersion(repoRoot, file, dst)))) {
    // The working tree changed since capture. We cannot tell an intended FF
    // from the user re-doing their edits after a cancelled run, so preserve
    // what's on disk and drop the snapshot's version alongside it for review.
    const backup = await backupCapturedVersionBesideDst(src, dst, stat);
    throw new StaleSnapshotConflict(file, backup);
  }
  if (diverged && reconcileBase && stat.isFile()) {
    // `dst` is clean committed HEAD content. If a commit since capture (the
    // fast-forward) changed this path, overlaying the captured copy would
    // silently revert that change: merge the two instead (threeWay.ts).
    const outcome = await reconcileWithCommittedChange(repoRoot, reconcileBase, file, src, dst);
    if (outcome.kind === 'conflict') {
      const backup = await backupCapturedVersionBesideDst(src, dst, stat);
      throw new StaleSnapshotConflict(file, backup, outcome.reason);
    }
    if (outcome.kind === 'merged') {
      if (await writeMergedVersion(dst, destinationVersion, outcome.content)) return;
      const backup = await backupCapturedVersionBesideDst(src, dst, stat);
      throw new StaleSnapshotConflict(file, backup, 'changed on disk while it was being merged');
    }
  }
  if (destinationExists) await removeExistingPathNoFollow(dst);
  if (stat.isSymbolicLink()) {
    const target = await fs.readlink(src);
    await fs.symlink(target, dst);
  } else {
    await fs.copyFile(src, dst, constants.COPYFILE_EXCL);
  }
}

// Write a three-way merge result over `dst`, only if `dst` is still the
// version the merge read (and a regular file: writing through a link would
// land outside the path). In place, so the file keeps its mode. False when
// `dst` changed meanwhile and was left as is.
async function writeMergedVersion(dst: string, expectedVersion: string | null, content: string): Promise<boolean> {
  const stat = await fs.lstat(dst);
  if (!stat.isFile() || (await pathVersion(dst)) !== expectedVersion) return false;
  await fs.writeFile(dst, content, 'utf8');
  return true;
}

// Re-apply a deletion the snapshot captured (the path was locally deleted; the
// capture resurrected HEAD's copy so the FF could run). There is no captured
// content to compare against, so the rule is the same in both modes: delete
// only a tracked file that is byte-identical to HEAD (recoverable with one
// `git checkout` if the user disagrees). Anything else — an edited file, an
// untracked replacement, a directory — is newer work and is kept; the throw
// makes restoreSnapshot report it and retain the snapshot dir.
export async function reapplySnapshotDeletion(repoRoot: string, file: string): Promise<void> {
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
    throw new SnapshotPathKept('a directory now exists at the captured deletion; keeping it');
  }
  if (!(await cleanTrackedVersion(repoRoot, file, dst))) {
    throw new SnapshotPathKept('on-disk content differs from HEAD; keeping it instead of re-deleting');
  }
  await fs.rm(dst, { force: true, recursive: false });
}
