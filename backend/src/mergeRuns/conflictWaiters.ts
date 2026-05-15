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
}
