// Copy-based working-tree snapshot. Replacement for
// `git stash --include-untracked`, which has a fatal failure mode for our
// purposes: if the stash is later lost (interrupted commit, dropped entry,
// process crash mid-pop), every untracked file it captured is silently
// deleted from the working tree. Two .git-deletion incidents on this
// project (2026-05-08, 2026-05-09) traced back to that pattern.
//
// What this gives us instead:
//   - Modified + untracked paths are *copied* to a stable directory under
//     ~/.lattice/snapshots/<projectHash>/<timestamp>-<label>/.
//   - The working tree is then reset (modified → HEAD, untracked → deleted)
//     so subsequent git operations (FF, merge) see a clean tree.
//   - On restore we copy the files back; on crash the snapshot dir is left
//     in place so the user can recover manually.
//   - Boot recovery (recoverPendingRunSnapshots) sweeps any orphaned
//     snapshots and restores them, so a server crash mid-run doesn't lose
//     work.
//
// Restore preserves newer dirty edits as the working copy and places captured
// versions beside them for reconciliation. An in-session restore may overlay
// clean committed HEAD content; boot recovery preserves all differing paths.
// Capture, finalization and restore share project ownership, and partial restore
// outcomes retain the snapshot and surface to the caller.
//
// Stable facade: implementation lives in ./snapshot/{manifest,capture,
// restore,recovery}.js so existing `./snapshot.js` imports keep working.

export {
  EMPTY_HANDLE,
  SNAPSHOTS_BASE,
  SNAPSHOT_MANIFEST_FILENAME,
  isSupportedSnapshotManifest,
  readSnapshotManifest,
  snapshotManifestPath,
  writeSnapshotManifest,
  type SnapshotHandle,
  type SnapshotManifest,
} from './snapshot/manifest.js';
export { parseStatus, snapshotWorkingTree } from './snapshot/capture.js';
export { discardSnapshot, restoreSnapshot, type SnapshotRestoreResult } from './snapshot/restore.js';
export { recoverPendingSnapshots } from './snapshot/recovery.js';
