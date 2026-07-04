import { applyTaskUpdate } from './taskUpdate.js';
import type { Task, TaskUpdates } from './types.js';

// The narrow slice of the task cache this module drives. Bound to the live
// manager instance by the caller so overrides (e.g. a test's fake
// writeStateNow) still dispatch virtually — this module never reaches past
// these operations into the cache internals.
export type CrashSafeCacheOps = {
  writeStateNow: (project: string, list: Task[]) => Promise<void>;
  cancelPendingPersist: (project: string) => void;
  getCached: (project: string) => Task[] | undefined;
  setCached: (project: string, list: Task[]) => void;
};

// The disk-before-cache core of updateTaskCrashSafe. Writes the task update to
// disk BEFORE touching the in-memory cache, then syncs the cache to match. If
// the server crashes between the disk write and the cache update, the next boot
// reads the correct state from disk. Used for critical one-way transitions
// (e.g. ready_to_merge → qa) where losing the update would leave the system in
// an inconsistent state.
//
// MUST run under the caller's per-project write lock (see
// TaskCacheManager.updateTaskCrashSafe), so it cannot interleave with a sibling
// create/update for the same project (the lost-concurrent-mutation bug): a
// Stop-hook flip or a sibling run-attempt bump landing during the disk write
// used to be reverted when the crash-safe update resumed and committed its
// pre-await snapshot. Inside the lock, after the disk write, we re-read the LIVE
// cache and re-apply only this task's delta — never the whole pre-write
// snapshot.
//
// Returns the updated task, or null if the disk write failed (in which case the
// cache is left untouched — disk was never changed either).
export async function applyCrashSafeTaskUpdate(
  ops: CrashSafeCacheOps,
  project: string,
  list: Task[],
  idx: number,
  id: string,
  updates: TaskUpdates,
): Promise<Task | null> {
  const { updated, updatedList } = applyTaskUpdate(list, idx, updates);
  // Step 1: write to disk FIRST. A crash here leaves disk as it was — safe.
  try {
    await ops.writeStateNow(project, updatedList);
  } catch (e) {
    console.error('[tasks] updateTaskCrashSafe disk write failed:', e);
    return null;
  }
  // Disk is up to date; drop any pending debounce so it can't later flush
  // a staler snapshot over it.
  ops.cancelPendingPersist(project);
  // Step 2: sync the cache. Re-read the LIVE cache and re-apply only this
  // task's delta to THAT array, never the pre-write snapshot — so a
  // sibling mutation committed during the disk write isn't reverted. The
  // per-project lock already excludes concurrent writers; this also keeps
  // the path correct against any future writer that bypasses the lock.
  const live = ops.getCached(project) ?? [];
  const liveIdx = live.findIndex((t) => t.id === id);
  const synced =
    liveIdx === -1
      ? updatedList
      : live.map((t, i) => (i === liveIdx ? updated : t));
  ops.setCached(project, synced);
  return updated;
}
