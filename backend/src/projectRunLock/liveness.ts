import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { LockBody } from './types.js';

const execFileAsync = promisify(execFile);

// Approximate startup time of THIS process. `process.uptime()` returns
// seconds since the process started; subtracting from `Date.now()` gives a
// usable epoch ms. Captured once at module load so it's stable.
//
// Why this exists: on Windows (smaller PID space, faster cycling) a dev
// server restart can land on a PID that was used by the previous backend
// — and that previous backend may have left a stale `run.lock` behind
// with its (now reused) PID inside. Without a way to disambiguate, the
// new backend's `isCurrentProcessHolder` would say "yes, that's me, the
// lock IS held by me right now" and `acquireProjectRunLock` would refuse
// to steal it, throwing `ProjectRunLockedError`. The symptom is a
// workflow control step (or merge run) aborting immediately on
// acquire — exactly the "workflow gets aborted right after combine
// tasks" symptom users hit after a stuck-hook dev restart. Comparing
// the lock body's `startedAt` to this process's start disambiguates: a
// lock created before this process started cannot belong to this
// process, regardless of PID.
const THIS_PROCESS_STARTED_AT = Date.now() - process.uptime() * 1000;

// Fuzz factor for `THIS_PROCESS_STARTED_AT` vs. lock `startedAt`. Both
// derive from `Date.now()` on this host, so they're in the same time base,
// but the lock can be created several ms after the process boots and our
// `process.uptime()` is sub-second precision. A second of slack covers
// boot races without weakening the PID-reuse check.
const PROCESS_START_FUZZ_MS = 1000;

export function currentLockBody(label: string): LockBody {
  return {
    pid: process.pid,
    hostname: os.hostname(),
    startedAt: Date.now(),
    label,
  };
}

// Did THIS running process actually create the lock? If pid+hostname
// match but the lock was created before our process started, it's a
// stale lock from a prior process that happened to be assigned the same
// PID (PID reuse — common enough on Windows dev restarts to have
// actually bitten the workflow engine in practice).
export function isCurrentProcessHolder(holder: LockBody): boolean {
  if (holder.pid !== process.pid) return false;
  if (holder.hostname !== os.hostname()) return false;
  if (holder.startedAt < THIS_PROCESS_STARTED_AT - PROCESS_START_FUZZ_MS) {
    return false;
  }
  return true;
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

// Best-effort wall-clock start time (epoch ms) of a live local process, or
// null if it can't be determined (process gone, permission denied, the
// query tool missing/erroring). Same time base as `Date.now()`.
export async function getProcessStartTimeMs(pid: number): Promise<number | null> {
  if (!Number.isFinite(pid) || pid <= 0) return null;
  try {
    if (process.platform === 'win32') {
      // .NET `DateTime.Ticks` = 100ns intervals since 0001-01-01 UTC;
      // 621355968000000000 of them have elapsed by the Unix epoch.
      const { stdout } = await execFileAsync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `try { (Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks } catch { '' }`,
        ],
        { timeout: 5000, windowsHide: true },
      );
      const ticks = Number(stdout.trim());
      if (!Number.isFinite(ticks) || ticks <= 0) return null;
      return Math.round((ticks - 621355968000000000) / 10000);
    }
    // POSIX: `ps -o lstart=` prints an absolute, parseable start timestamp.
    const { stdout } = await execFileAsync(
      'ps',
      ['-o', 'lstart=', '-p', String(pid)],
      { timeout: 5000 },
    );
    const parsed = Date.parse(stdout.trim());
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export async function isLockHolderAlive(holder: LockBody): Promise<boolean> {
  // Different host = always treat as alive (we can't probe a remote PID
  // from here).
  if (holder.hostname !== os.hostname()) return true;
  // If the PID matches ours but the lock pre-dates our process, the
  // original holder is gone even though the PID itself is now alive
  // again (it's us, the new process). Treat as dead so the caller steals.
  if (
    holder.pid === process.pid &&
    holder.startedAt < THIS_PROCESS_STARTED_AT - PROCESS_START_FUZZ_MS
  ) {
    return false;
  }
  if (!isProcessAlive(holder.pid)) return false;
  // The PID is live — but the OS recycles PIDs (aggressively on Windows),
  // so a long-dead holder's PID can now belong to an unrelated process. A
  // genuine holder was necessarily running when it wrote the lock, so its
  // start time precedes `startedAt`; a process that started *after* the
  // lock cannot be the holder — the PID was reused and the real holder is
  // gone. Without this, a stale workflow-merge lock left by a crashed
  // backend stays un-stealable forever and silently aborts every later
  // run on that project.
  const startedMs = await getProcessStartTimeMs(holder.pid);
  if (startedMs !== null && startedMs > holder.startedAt + PROCESS_START_FUZZ_MS) {
    return false;
  }
  return true;
}
