import {
  readSnapshotManifest,
  snapshotManifestPath,
  writeSnapshotManifest,
  type RetiredSnapshotPath,
} from './manifest.js';
import type { SnapshotRestoreResult } from './restoreTypes.js';

// After a partial restore, narrow the on-disk manifest to the paths still
// worth retrying. Left whole, every later boot re-applied the entire manifest:
// files the user had since deleted came back with stale content, and each
// file edited since got a fresh `.lattice-conflict` copy, forever, since the
// snapshot never cleared while any path still differed. Restored and
// backed-up paths are recorded under `retired`; when nothing is left the
// snapshot is `archived`: its payload kept for the user, never auto-restored.
export async function retireSettledEntries(
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
