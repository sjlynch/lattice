import path from 'node:path';
import fs from 'node:fs/promises';
import { projectHash } from '../../projectPath.js';
import { isPathInsideRepo } from '../paths.js';
import {
  SNAPSHOTS_BASE,
  readSnapshotManifest,
  snapshotManifestPath,
} from './manifest.js';
import { restoreSnapshot } from './restore.js';
import { withProjectRunLock } from '../../projectRunLock.js';
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
      const snapDir = path.join(projectSnapshotsDir, snap);
      const manifestPath = snapshotManifestPath(snapDir);
      const manifest = await readSnapshotManifest(manifestPath);
      if (!manifest) {
        // Missing/corrupt/unsupported manifest — leave it alone, user will
        // see and can clean up.
        continue;
      }
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
        continue;
      }
      if (expectedHash !== dirHash) {
        console.error(
          `[snapshot] refusing to restore ${snapDir} — manifest.repoRoot ` +
            `"${manifest.repoRoot}" hashes to ${expectedHash}, but it lives ` +
            `under directory ${dirHash}. Possibly tampered or relocated; ` +
            `leaving for manual inspection.`,
        );
        continue;
      }
      // Per-entry path validation happens inside restoreSnapshot, but we
      // also pre-check here so the log message reflects the real count.
      const allFiles = [
        ...(manifest.modifiedTracked ?? []),
        ...(manifest.untracked ?? []),
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
        continue;
      }
      console.warn(
        `[snapshot] auto-restoring ${manifest.label} snapshot ` +
          `(${safeFiles.length} file(s)) → ${manifest.repoRoot}`,
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
            },
            repoRoot,
            { guardStaleOverwrite: true },
          );
        });
      } catch (err) {
        console.warn(`[snapshot] recovery deferred for ${snapDir}: ${(err as Error).message}`);
      }
    }
  }
}
