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
export class SnapshotPathKept extends Error {}

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
