import path from 'node:path';
import fs from 'node:fs/promises';
import { projectHash } from '../../projectPath.js';
import { isPathInsideRepo } from '../paths.js';
import {
  SNAPSHOTS_BASE,
  readSnapshotManifest,
  snapshotManifestPath,
  type SnapshotManifest,
} from './manifest.js';
import { restoreSnapshot } from './restore.js';
import { inspectProjectRunLock, withProjectRunLock } from '../../projectRunLock.js';
import { isResumableInterruptedRunLock, recordInterruptedRun } from '../../projectRunLock/interruptedRun.js';
import { storedProjectRoot } from '../../projectIdentity.js';

// Boot-time recovery: scan ~/.lattice/snapshots/ for any leftover
// snapshots (a previous backend crashed mid-run) and restore them into
// their original repos. Logs each restore loudly. Idempotent on a clean
// snapshots dir (just enumerates and exits).
//
// Why this matters: the previous stash-based approach used a fixed label
// (`lattice-run-stash`) so a stash from a cancelled/crashed run was
// re-popped by the next run. The snapshot replacement needs equivalent
// semantics — otherwise a crash leaves the user's mods stranded in a
// snapshot dir until they manually copy them back.
export async function recoverPendingSnapshots(): Promise<void> {
  for await (const { snapDir, dirHash } of listPendingSnapshotDirs()) {
    const validated = await validateSnapshotForRecovery(snapDir, dirHash);
    if (!validated) continue;
    await recoverOneSnapshot(snapDir, validated);
  }
}

type ValidatedSnapshot = {
  manifest: SnapshotManifest;
  manifestPath: string;
  repoRoot: string;
  safeFileCount: number;
};

// Two-level readdir of SNAPSHOTS_BASE (`<hash>/<snapshot>`). Lazy, so each
// project's listing is read only once the previous project's snapshots were
// processed. A missing base is simply "nothing to recover"; an unreadable
// project dir is skipped.
async function* listPendingSnapshotDirs(): AsyncGenerator<{ snapDir: string; dirHash: string }> {
  let projectDirs: string[];
  try {
    projectDirs = await fs.readdir(SNAPSHOTS_BASE);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    console.warn(`[snapshot] recovery scan failed: ${(err as Error).message}`);
    return;
  }
  for (const dirHash of projectDirs) {
    const projectSnapshotsDir = path.join(SNAPSHOTS_BASE, dirHash);
    let snapshots: string[];
    try {
      snapshots = await fs.readdir(projectSnapshotsDir);
    } catch {
      continue;
    }
    for (const snap of snapshots) {
      yield { snapDir: path.join(projectSnapshotsDir, snap), dirHash };
    }
  }
}

// Returns null (skip) for anything boot recovery must leave alone; otherwise
// the manifest plus the identity-checked repo root to restore into.
async function validateSnapshotForRecovery(
  snapDir: string,
  dirHash: string,
): Promise<ValidatedSnapshot | null> {
  const manifestPath = snapshotManifestPath(snapDir);
  const manifest = await readSnapshotManifest(manifestPath);
  if (!manifest) {
    // Missing/corrupt/unsupported manifest — leave it alone, user will
    // see and can clean up. This is also how discarded-worktree archives
    // (../discardArchive.ts) are skipped: they carry
    // _lattice-discarded-worktree.json instead, because they are a
    // keep-for-the-user copy of a WORKTREE's edits, never a pending
    // restore into the project tree.
    return null;
  }
  // A partial restore settled every path it could (restored, or backed
  // up as a `.lattice-conflict` copy) and kept the dir only as an archive
  // for the user (restore.ts retireSettledEntries). Re-applying it would
  // resurrect files the user deleted and re-create reviewed conflicts.
  if (manifest.archived) return null;
  // Defence in depth: a tampered manifest could claim repoRoot is
  // anywhere on disk (`C:\Windows\System32`, the user's home, another
  // project). The directory hash is computed from the canonical path,
  // so we recompute it from manifest.repoRoot and refuse to restore
  // if it doesn't match the directory the manifest lives in. A real
  // Lattice-written snapshot always satisfies this.
  let expectedHash: string;
  let repoRoot: string;
  try {
    repoRoot = storedProjectRoot(manifest.repoRoot, dirHash);
    expectedHash = projectHash(repoRoot);
  }
  catch (err) {
    console.warn(`[snapshot] identity check deferred for ${snapDir}: ${(err as Error).message}`);
    return null;
  }
  if (expectedHash !== dirHash) {
    console.error(
      `[snapshot] refusing to restore ${snapDir} — manifest.repoRoot ` +
        `"${manifest.repoRoot}" hashes to ${expectedHash}, but it lives ` +
        `under directory ${dirHash}. Possibly tampered or relocated; ` +
        `leaving for manual inspection.`,
    );
    return null;
  }
  // Per-entry path validation happens inside restoreSnapshot, but we
  // also pre-check here so the log message reflects the real count.
  const allFiles = [
    ...(manifest.modifiedTracked ?? []),
    ...(manifest.untracked ?? []),
    ...(manifest.deleted ?? []),
  ];
  const safeFiles = allFiles.filter((f) =>
    isPathInsideRepo(repoRoot, f),
  );
  if (safeFiles.length !== allFiles.length) {
    console.error(
      `[snapshot] manifest at ${manifestPath} contains ` +
        `${allFiles.length - safeFiles.length} unsafe path(s); they ` +
        `will be skipped during restore.`,
    );
  }
  // Only auto-restore if the target repo still exists. If the user
  // moved/deleted the project, leave the snapshot in place.
  try {
    await fs.access(repoRoot);
  } catch {
    console.warn(
      `[snapshot] orphan snapshot ${snapDir} → repoRoot ${manifest.repoRoot} ` +
        `does not exist; leaving for manual cleanup`,
    );
    return null;
  }
  return { manifest, manifestPath, repoRoot, safeFileCount: safeFiles.length };
}

async function recoverOneSnapshot(
  snapDir: string,
  { manifest, manifestPath, repoRoot, safeFileCount }: ValidatedSnapshot,
): Promise<void> {
  console.warn(
    `[snapshot] auto-restoring ${manifest.label} snapshot ` +
      `(${safeFileCount} file(s)) → ${manifest.repoRoot}`,
  );
  // guardStaleOverwrite: this is a DEFERRED restore — the snapshot was
  // retained (a cancelled run, or a partial-failure retain) and is only
  // now being re-applied, possibly long after capture and across a
  // restart. In between, the user may have re-done or edited these files
  // (routine in dev under tsc -w). Unlike an immediate in-session restore,
  // silently overwriting them here is data loss, so any path whose on-disk
  // content diverged from the capture is preserved and the snapshot's
  // version is dropped beside it for manual review.
  try {
    await noteInterruptedRunBeforeSteal(repoRoot);
    // Do NOT borrow an in-process owner here: this snapshot might belong
    // to its live merge. A fresh exclusive acquire refuses all live runs.
    await withProjectRunLock(repoRoot, 'snapshot-recovery', async () => {
      const current = await readSnapshotManifest(manifestPath);
      if (!current || JSON.stringify(current) !== JSON.stringify(manifest)) return;
      console.warn(`[snapshot] acquired recovery ownership for ${snapDir}`);
      await restoreSnapshot(
        {
          dir: snapDir,
          modifiedTracked: current.modifiedTracked,
          untracked: current.untracked,
          deleted: current.deleted ?? [],
          ...(current.baseCommit ? { baseCommit: current.baseCommit } : {}),
        },
        repoRoot,
        { guardStaleOverwrite: true },
      );
    });
  } catch (err) {
    console.warn(`[snapshot] recovery deferred for ${snapDir}: ${(err as Error).message}`);
  }
}

// recoverOneSnapshot's `withProjectRunLock` steals and retires a dead
// holder's lock. When that holder
// was an interrupted Merge All / workflow Merge or Push step, the lock is how
// the later boot steps (`resumeInterruptedMergeRuns`, the owed post-merge hook
// check) learn a merge was cut short — so record it for them first
// (projectRunLock/interruptedRun.ts). Best-effort: a failure here must not
// block restoring the user's work.
async function noteInterruptedRunBeforeSteal(repoRoot: string): Promise<void> {
  try {
    const lock = await inspectProjectRunLock(repoRoot);
    if (!lock || lock.alive || !isResumableInterruptedRunLock(lock.holder.label)) return;
    await recordInterruptedRun(repoRoot, lock.holder);
    console.warn(
      `[snapshot] recovery will retire the dead "${lock.holder.label}" run lock for ${repoRoot}; ` +
        'recorded it so the interrupted merge still resumes',
    );
  } catch (err) {
    console.warn(`[snapshot] could not record the interrupted run for ${repoRoot}: ${(err as Error).message}`);
  }
}
