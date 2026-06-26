// Per-task in-flight merge lock.
//
// /api/tasks/:id/merge and the merge-run worker both end up calling
// `mergeWorktreeInRepo` + `finalizeMergedTask` for the same task. Without
// a lock, a user double-click or a manual /merge call landing while the
// run worker is processing the same task can race on the same git
// directory and leave the repo half-merged. The lock is in-process — fine
// for our single-backend topology — and is released even if the caller
// throws.

export type MergeLockToken = {
  readonly taskId: string;
  readonly owner: symbol;
};

const inFlight = new Map<string, symbol>();

export function tryAcquire(taskId: string): MergeLockToken | null {
  if (inFlight.has(taskId)) return null;
  const owner = Symbol(taskId);
  inFlight.set(taskId, owner);
  return { taskId, owner };
}

export function release(token: MergeLockToken): boolean {
  if (inFlight.get(token.taskId) !== token.owner) return false;
  inFlight.delete(token.taskId);
  return true;
}

export function isLocked(taskId: string): boolean {
  return inFlight.has(taskId);
}
