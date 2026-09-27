// Hand-written declarations for the per-policy parked-agent probe cache.
// Keep in sync with parkedProbe.mjs.

import type { LockHoldersReport, RunLock } from './runLocks.mjs';

export function createParkedProbeCache(args: {
  now: () => number;
  queryLockHolders?: () => Promise<LockHoldersReport | null | undefined>;
  ttlMs: number;
}): {
  // A report for the exact lock set, younger than the injected TTL.
  freshReport(locks: RunLock[]): LockHoldersReport | null;
  // Start a query unless one is already in flight or no callback is configured.
  start(locks: RunLock[]): void;
  // Refresh at half the TTL; used only while the policy holds a parked run.
  refreshIfDue(locks: RunLock[]): void;
};
