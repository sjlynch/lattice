import path from 'node:path';
import fs from 'node:fs/promises';
import { withProjectMutation } from '../../projectRunLock.js';
import { isPathInsideRepo } from '../paths.js';
import { isSnapshotMetadataPath, type SnapshotHandle } from './manifest.js';
import { assertNotReparsePoint } from '../cleanupSafety.js';
import { reapplySnapshotDeletion, restoreSnapshotPath } from './restorePath.js';
import { retireSettledEntries } from './restoreRetirement.js';
import {
  SNAPSHOT_CONFLICT_SUFFIX,
  SnapshotPathKept,
  StaleSnapshotConflict,
  type RestoreSnapshotOptions,
  type SnapshotRestoreResult,
} from './restoreTypes.js';

export {
  SNAPSHOT_CONFLICT_SUFFIX,
  StaleSnapshotConflict,
  type RestoreSnapshotOptions,
  type SnapshotRestoreResult,
} from './restoreTypes.js';

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
