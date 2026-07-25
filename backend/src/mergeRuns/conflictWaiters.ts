import type { ConflictWaiterEntry } from './types.js';

// In-process resolver waiters are deliberately keyed by taskId, not runId.
// A resolver Stop hook belongs to one conflict task; task-id lookup prevents
// task A's completion from accidentally releasing a waiter for task B in the
// same sequential merge run.
export class ConflictWaiterRegistry {
  private readonly waiters = new Map<string, ConflictWaiterEntry>();

  public register(runId: string, taskId: string): Promise<void> {
    return new Promise<void>((resolve) => {
      this.waiters.set(taskId, { runId, resolve });
    });
  }

  public signal(taskId: string): boolean {
    const entry = this.waiters.get(taskId);
    if (!entry) return false;
    this.waiters.delete(taskId);
    entry.resolve();
    return true;
  }

  public unblockRun(runId: string): boolean {
    for (const [taskId, entry] of this.waiters) {
      if (entry.runId === runId) {
        this.waiters.delete(taskId);
        entry.resolve();
        return true;
      }
    }
    return false;
  }

  // Drop a waiter that the liveness backstop is releasing because the resolver
  // pty died (or the wait timed out) without any completion callback. Unlike
  // `signal`, this is NOT a real completion — but it still resolves the pending
  // promise so the parked run worker wakes, and removes the entry so a stray
  // late callback can't find a phantom waiter (and it doesn't leak). Guarded on
  // `runId` so a stale abandon can't drop a *different* run's waiter that has
  // re-registered under the same taskId (a re-queued task in a fresh run).
  public abandon(taskId: string, runId: string): boolean {
    const entry = this.waiters.get(taskId);
    if (!entry || entry.runId !== runId) return false;
    this.waiters.delete(taskId);
    entry.resolve();
    return true;
  }
}
