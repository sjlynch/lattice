import path from 'node:path';
import fs from 'node:fs/promises';
import { withProjectMutation } from '../../projectRunLock.js';
import { constants, type Stats } from 'node:fs';
import { isPathInsideRepo } from '../paths.js';
import {
  isCommitId,
  isSnapshotMetadataPath,
  readSnapshotManifest,
  snapshotManifestPath,
  writeSnapshotManifest,
  type RetiredSnapshotPath,
  type SnapshotHandle,
} from './manifest.js';
import { assertNotReparsePoint } from '../cleanupSafety.js';
import { projectGit } from '../projectGit.js';
import { pathVersion } from './versions.js';
import { deletedSinceCapture, reconcileWithCommittedChange } from './threeWay.js';

// Suffix for the copy we leave beside a path whose on-disk content diverged
// from the snapshot when the stale-overwrite guard is engaged (boot recovery).
// Rather than clobber the newer on-disk file, we drop the snapshot's captured
// version at `<path><this suffix>` and keep the original in place.
export const SNAPSHOT_CONFLICT_SUFFIX = '.lattice-conflict';

// Thrown by restoreSnapshotPath when a path's on-disk content differs from
// what the snapshot captured and cannot take the captured copy (a newer edit,
// or a fast-forward change that won't merge with it). It is NOT a
// failure to write — the captured version has already been backed up beside
// the on-disk file — but restoreSnapshot treats it like one so the snapshot
// dir is retained for the user to reconcile.
export class StaleSnapshotConflict extends Error {
  constructor(
    readonly file: string,
    readonly backupPath: string,
    // Why the captured copy could not be put back; default: the file changed
    // on disk after capture.
    reason?: string,
  ) {
    super(
      reason
        ? `${file}: ${reason}; kept the working-tree version, backed up snapshot copy to ${backupPath}`
        : `on-disk ${file} changed since capture; kept it, backed up snapshot copy to ${backupPath}`,
    );
    this.name = 'StaleSnapshotConflict';
  }
}

// A path restore deliberately left alone because the working tree holds newer
// work (e.g. a captured deletion whose file was edited since). Reported as a
// failure, but retrying it on a later boot can only undo that decision, so a
// partial restore does not keep it pending (see retireSettledEntries).
class SnapshotPathKept extends Error {}

// Options controlling how the snapshot is written back into the working tree.
export type RestoreSnapshotOptions = {
  // Default: preserve differing dirty/untracked destinations; a tracked
  // destination verified clean against HEAD is overlaid when HEAD's version of
  // it is still the capture base, and three-way merged with the captured copy
  // when a commit since capture (the fast-forward) changed it — a conflict
  // keeps HEAD's version and backs the copy up. True (boot recovery):
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
    throw new SnapshotPathKept('a directory now exists at the captured deletion; keeping it');
  }
  if (!(await cleanTrackedVersion(repoRoot, file, dst))) {
    throw new SnapshotPathKept('on-disk content differs from HEAD; keeping it instead of re-deleting');
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
  const trackedSet = new Set(handle.modifiedTracked);
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
  // Paths whose failure a later attempt might fix (an I/O error, a busy
  // file). Everything else is settled: restored, backed up as a conflict
  // copy, kept on purpose, or never restorable (unsafe).
  const retryable = new Set<string>();
  for (const file of safe) {
    try {
      if (deletions.has(file)) await reapplySnapshotDeletion(repoRoot, file);
      else await restoreSnapshotPath(handle.dir, repoRoot, file, opts, { commit: handle.baseCommit, tracked: trackedSet.has(file) });
      result.restored.push(file);
    } catch (err) {
      failed += 1;
      if (!(err instanceof StaleSnapshotConflict) && !(err instanceof SnapshotPathKept)) retryable.add(file);
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
    await retireSettledEntries(handle.dir, result, retryable);
  }
  return result;
}

// After a partial restore, narrow the on-disk manifest to the paths still
// worth retrying. Left whole, every later boot re-applied the entire manifest:
// files the user had since deleted came back with stale content, and each
// file edited since got a fresh `.lattice-conflict` copy, forever, since the
// snapshot never cleared while any path still differed. Restored and
// backed-up paths are recorded under `retired`; when nothing is left the
// snapshot is `archived`: its payload kept for the user, never auto-restored.
async function retireSettledEntries(
  snapshotDir: string,
  result: SnapshotRestoreResult,
  retryable: ReadonlySet<string>,
): Promise<void> {
  try {
    const manifest = await readSnapshotManifest(snapshotManifestPath(snapshotDir));
    if (!manifest) return; // a hand-built handle, or unreadable: nothing to narrow
    const keep = (files: string[]) => files.filter((file) => retryable.has(file));
    const at = Date.now();
    const retired: RetiredSnapshotPath[] = [
      ...result.restored.map((file) => ({ file, outcome: 'restored' as const, at })),
      ...result.conflicts.map(({ file, backupPath }) => ({ file, outcome: 'conflict' as const, backupPath, at })),
      ...result.failed
        .filter(({ file }) => !retryable.has(file))
        .map(({ file, message }) => ({ file, outcome: 'failed' as const, message, at })),
    ];
    const modifiedTracked = keep(manifest.modifiedTracked);
    const untracked = keep(manifest.untracked);
    const deleted = keep(manifest.deleted ?? []);
    const archived = modifiedTracked.length + untracked.length + deleted.length === 0;
    await writeSnapshotManifest(snapshotDir, {
      ...manifest,
      modifiedTracked,
      untracked,
      ...(manifest.deleted ? { deleted } : {}),
      retired: [...(manifest.retired ?? []), ...retired],
      ...(archived ? { archived: true } : {}),
    });
    console.warn(
      archived
        ? `[snapshot] ${snapshotDir}: nothing left to retry; kept as an archive, not restored again on boot`
        : `[snapshot] ${snapshotDir}: ${retryable.size} path(s) still pending for boot recovery`,
    );
  } catch (err) {
    console.warn(`[snapshot] could not narrow the manifest of ${snapshotDir}: ${(err as Error).message}`);
  }
}

// One-line user-facing summary of a partial restore, naming the conflict
// copies so the user knows where their captured edits went.
export function describePartialRestore(result: SnapshotRestoreResult, snapshotDir: string): string {
  const list = (files: string[]) => files.slice(0, 5).join(', ') + (files.length > 5 ? ` (+${files.length - 5} more)` : '');
  const parts: string[] = [];
  if (result.conflicts.length > 0) {
    parts.push(
      `${result.conflicts.length} file(s) kept their working-tree version and your captured copy was saved beside ` +
        `each as ${SNAPSHOT_CONFLICT_SUFFIX}: ${list(result.conflicts.map((c) => c.file))}`,
    );
  }
  if (result.failed.length > 0) {
    parts.push(`${result.failed.length} file(s) not restored: ${list(result.failed.map((f) => f.file))}`);
  }
  return `Snapshot partly restored; ${parts.join('; ') || 'newer edits preserved'}; captured versions retained at ${snapshotDir}`;
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
