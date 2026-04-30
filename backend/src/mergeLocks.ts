// Per-task in-flight merge lock.
//
// /api/tasks/:id/merge and the merge-run worker both end up calling
// `mergeWorktreeInRepo` + `finalizeMergedTask` for the same task. Without
// a lock, a user double-click or a manual /merge call landing while the
// run worker is processing the same task can race on the same git
// directory and leave the repo half-merged. The lock is in-process — fine
// for our single-backend topology — and is released even if the caller
// throws.

const inFlight = new Set<string>();

export function tryAcquire(taskId: string): boolean {
  if (inFlight.has(taskId)) return false;
  inFlight.add(taskId);
  return true;
}

export function release(taskId: string): void {
  inFlight.delete(taskId);
}

export function isLocked(taskId: string): boolean {
  return inFlight.has(taskId);
}
