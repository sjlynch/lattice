// run.lock discovery for the dev-runner restart policy (restartPolicy.mjs):
// which per-project run.locks are held by a live local process, how to
// describe them in a log line, and whether the backend reports their holders
// parked on a live agent. Plain ESM on `node:` builtins only — this runner must
// not load compiled `dist/` modules.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const PER_PROJECT_DIR = path.join(os.homedir(), '.lattice', 'per-project');
// Slack between a lock's `startedAt` and the OS-reported start time of its
// PID (mirrors PROCESS_START_FUZZ_MS in backend/src/projectRunLock/liveness.ts).
export const PROCESS_START_FUZZ_MS = 1000;

export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return Boolean(err) && err.code !== 'ESRCH'; // EPERM etc → assume alive
  }
}

// Best-effort wall-clock start time (epoch ms) of a live local process, or
// null when it can't be determined (process gone, permission denied, the query
// tool missing). Same time base as `Date.now()`. A synchronous port of
// `getProcessStartTimeMs` in backend/src/projectRunLock/liveness.ts — this
// runner is plain ESM that must not load compiled `dist/` modules, and the
// restart decision is made from a synchronous poll. It spawns PowerShell on
// win32, so callers cache the answer per lock body (see `heldRunLocks`).
export function processStartTimeMs(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    if (process.platform === 'win32') {
      // .NET `DateTime.Ticks` = 100ns intervals since 0001-01-01 UTC;
      // 621355968000000000 of them have elapsed by the Unix epoch.
      const stdout = execFileSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `try { (Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks } catch { '' }`,
        ],
        { timeout: 5000, windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
      );
      const ticks = Number(stdout.trim());
      if (!Number.isFinite(ticks) || ticks <= 0) return null;
      return Math.round((ticks - 621355968000000000) / 10000);
    }
    // POSIX: `ps -o lstart=` prints an absolute, parseable start timestamp.
    const stdout = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      timeout: 5000,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const parsed = Date.parse(stdout.trim());
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// Process-start-time answers, keyed by the exact `(pid, startedAt, ownerId)`
// lock body they were probed for. A lock body never changes while it is held
// (a new run writes a new body), so one probe per body is enough — and the
// 3 s deferred-restart poll must never re-spawn PowerShell. Entries whose lock
// has vanished are dropped on the next scan.
const START_TIME_CACHE = new Map();

function lockStartKey(body) {
  return `${body.pid}:${body.startedAt}:${body.ownerId ?? ''}`;
}

export function isWorkflowLockLabel(label) {
  return typeof label === 'string' && label.startsWith('workflow-');
}

// Every per-project run.lock currently held by a LIVE process on THIS host,
// across all projects, as `{hash, label, pid, startedAt}` records. Cheap —
// only read on a dist/ change or while a restart is deferred. Skipped, because
// none of them is an operation inside the local backend that a restart could
// interrupt:
//   - a lock written on another host (we cannot probe its PID; the backend's
//     own liveness check conservatively calls it alive, but it is not OURS);
//   - a dead-PID lock leaked by a killed process (boot recovery retires it);
//   - a live PID whose OS start time is NEWER than the lock's `startedAt` —
//     the OS recycled the PID into an unrelated process and the real holder is
//     gone. Without this a stale lock deferred restarts for MAX_DEFER_MS
//     (2026-09-22: a 15-min unexplained deferral with nothing in flight).
// `null` (uncertain) start time ⇒ assume alive, same as the backend.
export function heldRunLocks({
  perProjectDir = PER_PROJECT_DIR,
  isPidAlive = pidAlive,
  hostname = os.hostname(),
  readProcessStartTime = processStartTimeMs,
  startTimeCache = START_TIME_CACHE,
} = {}) {
  let hashes;
  try {
    hashes = fs.readdirSync(perProjectDir);
  } catch {
    return []; // dir doesn't exist yet → nothing running
  }
  const locks = [];
  const seenKeys = new Set();
  for (const h of hashes) {
    let raw;
    try {
      raw = fs.readFileSync(path.join(perProjectDir, h, 'run.lock'), 'utf8');
    } catch {
      continue;
    }
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      continue;
    }
    if (!body || typeof body.pid !== 'number') continue;
    if (typeof body.hostname === 'string' && body.hostname !== hostname) continue;
    if (!isPidAlive(body.pid)) continue;
    const startedAt = typeof body.startedAt === 'number' ? body.startedAt : 0;
    const key = lockStartKey(body);
    seenKeys.add(key);
    if (!startTimeCache.has(key)) startTimeCache.set(key, readProcessStartTime(body.pid));
    const processStartedAt = startTimeCache.get(key);
    if (
      typeof processStartedAt === 'number' &&
      startedAt > 0 &&
      processStartedAt > startedAt + PROCESS_START_FUZZ_MS
    ) {
      continue; // PID recycled — the holder that wrote this lock is dead
    }
    locks.push({
      hash: h,
      label: typeof body.label === 'string' ? body.label : '',
      pid: body.pid,
      startedAt,
    });
  }
  for (const key of startTimeCache.keys()) {
    if (!seenKeys.has(key)) startTimeCache.delete(key);
  }
  return locks;
}

// Labels of every live run.lock (see `heldRunLocks`).
export function heldRunLockLabels(opts) {
  return heldRunLocks(opts).map((lock) => lock.label);
}

// One-line, log-ready description of the holders: which project hash, which
// op, which PID, since when — the line that makes an unexplained deferred or
// forced restart attributable after the fact.
export function describeRunLocks(locks) {
  if (!locks || locks.length === 0) return 'no run.lock';
  return locks
    .map((lock) => {
      const since =
        Number.isFinite(lock.startedAt) && lock.startedAt > 0
          ? new Date(lock.startedAt).toISOString()
          : '?';
      return `${lock.hash} label=${lock.label || '?'} pid=${lock.pid} startedAt=${since}`;
    })
    .join('; ');
}

// True if any Lattice process holds a per-project run.lock (a merge run, a
// manual /merge, or a workflow control step). Used to decide whether to defer a
// restart at all — we defer for every kind.
export function repoOperationInFlight(opts) {
  return heldRunLockLabels(opts).length > 0;
}

// True if a live WORKFLOW control step (start/merge/push — the lock label is
// `workflow-<kind>:<runId>`, see backend/src/workflowRuns/controlStep.ts — or a
// Run tests step, `workflow-test:<runId>`) holds a run.lock. These are EXEMPT
// from the MAX_DEFER_MS force-restart backstop: a workflow's Merge step holds
// the lock for the ENTIRE time its tasks take to commit (routinely far longer
// than 15 min). The run record itself survives a restart (mirrored to
// ~/.lattice/per-project/<hash>/workflow-runs.json and re-adopted at boot, see
// backend/src/recovery/workflowRunResume.ts), but a control step executes
// in-process: the kill aborts it mid-flight and boot can only RE-RUN it from
// the top (re-draining lanes, re-starting merge runs, re-spawning a push) —
// churn and a visible hiccup rather than lost work. So we keep deferring the
// restart until the workflow itself releases the lock. The user can cancel the
// workflow if they need the restart sooner.
export function workflowRunInFlight(opts) {
  return heldRunLockLabels(opts).some(isWorkflowLockLabel);
}

// Did the backend's lock-holder report say EVERY held lock belongs to this
// backend (pid match) and is parked on a live agent? Pure; the report shape is
// GET /api/internal/restart-drain/lock-holders.
export function locksParkedOnLiveAgents(locks, report) {
  if (!report || !report.ok || !Array.isArray(report.holders) || locks.length === 0) return false;
  return locks.every((lock) =>
    lock.pid === report.pid &&
    report.holders.some((h) => h && h.hash === lock.hash && typeof h.parkedOn === 'string' && h.parkedOn));
}

// Log-ready reason the holders are (not) parked on a live agent, for the
// deferred-restart poll's hold / force lines.
export function parkedDetail(locks, report) {
  if (!report) return 'no answer';
  if (!report.ok) return report.why;
  const details = locks
    .map((lock) => report.holders.find((h) => h && h.hash === lock.hash))
    .filter(Boolean)
    .map((h) => `${h.hash}: ${h.detail || h.parkedOn || 'not parked'}`);
  return details.length ? details.join('; ') : 'the backend reports no agent the lock holder is waiting on';
}
