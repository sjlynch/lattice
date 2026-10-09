// Copy-based working-tree snapshot — the replacement for
// `git stash --include-untracked`, whose lost stash (interrupted commit, dropped
// entry, crash mid-pop) silently deletes every untracked file it captured (the
// root of two `.git`-deletion incidents). Contract: worktree/snapshot/CLAUDE.md.
//
//   - Modified + untracked paths are *copied* to a stable directory under
//     ~/.lattice/snapshots/<projectHash>/<timestamp>-<label>/.
//   - The working tree is then reset (modified → HEAD, untracked → deleted) so
//     subsequent git operations (FF, merge) see a clean tree.
//   - Restore copies the files back; on crash the snapshot dir is left in place
//     so the user can recover manually, and boot recovery
//     (recoverPendingRunSnapshots) restores orphaned snapshots.
//
// Restore preserves newer dirty edits as the working copy and places captured
// versions beside them for reconciliation. An in-session restore may overlay
// clean committed HEAD content; boot recovery preserves all differing paths.
// Capture, finalization and restore share project ownership, and partial restore
// outcomes retain the snapshot and surface to the caller.
//
// Stable facade over ./snapshot/{manifest,capture,restore,recovery}.js, so
// existing `./snapshot.js` imports keep working.

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
export { describePartialRestore, restoreSnapshot, type SnapshotRestoreResult } from './snapshot/restore.js';
export { recoverPendingSnapshots } from './snapshot/recovery.js';
