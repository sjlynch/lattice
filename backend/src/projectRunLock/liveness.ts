import os from 'node:os';
import type { LockBody } from './types.js';

export function currentLockBody(label: string): LockBody {
  return {
    pid: process.pid,
    hostname: os.hostname(),
    startedAt: Date.now(),
    label,
  };
}

export function isCurrentProcessHolder(holder: LockBody): boolean {
  return holder.pid === process.pid && holder.hostname === os.hostname();
}

// `process.kill(pid, 0)` doesn't actually kill — it just probes. ESRCH
// means the PID is gone. EPERM means alive but we can't signal it (still
// "held"). Anything else also treats as alive (fail safe).
export function isProcessAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

export function isLockHolderAlive(holder: LockBody): boolean {
  // Different host = always treat as alive (we can't probe a remote PID
  // from here).
  if (holder.hostname !== os.hostname()) return true;
  return isProcessAlive(holder.pid);
}
