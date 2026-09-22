import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  describeDistEvent,
  newestDistMtimeMs,
  shouldRestartForDist,
} from './distSignature.mjs';

export const PER_PROJECT_DIR = path.join(os.homedir(), '.lattice', 'per-project');
export const RESTART_DEBOUNCE_MS = 250;
export const DEFERRED_RESTART_POLL_MS = 3000;
// A metadata-only dist/ watch event (see distSignature.mjs) is normal
// background noise on Windows, so log it — but rarely, and with a count, so it
// stays a diagnostic rather than console spam.
export const IGNORED_EVENT_LOG_THROTTLE_MS = 60 * 1000;
// Don't defer a restart forever for a re-runnable operation (a merge run or a
// manual /merge) that holds the lock — after this long, restart anyway (the
// run is interrupted, then auto-resumed on the next boot). NOTE: "re-runnable"
// is not "short": a merge run that is waiting on a conflict-resolver Claude
// can legitimately hold the lock well past 15 min, and this backstop WILL
// interrupt that wait — the resumed run re-attempts the task, but the resolver
// session it was waiting on is orphaned (no exemption is implemented; the
// defer/force lines name the holder so such a restart is attributable).
// A workflow control step is deliberately exempt from this (see
// `workflowRunInFlight` / `classifyDeferAction`).
export const MAX_DEFER_MS = 15 * 60 * 1000;
// While a non-workflow op holds a deferred restart inside the window, re-log
// WHICH lock is holding it at most this often (the 3 s poll otherwise says
// nothing at all between the defer line and the force line).
export const HOLD_LOG_THROTTLE_MS = 60 * 1000;
// Slack between a lock's `startedAt` and the OS-reported start time of its
// PID (mirrors PROCESS_START_FUZZ_MS in backend/src/projectRunLock/liveness.ts).
export const PROCESS_START_FUZZ_MS = 1000;
// While a workflow legitimately holds the lock past MAX_DEFER_MS, re-log the
// "still holding the restart" notice at most this often so a long defer isn't a
// silent mystery, without spamming the 3s poll.
export const WORKFLOW_DEFER_RELOG_MS = 5 * 60 * 1000;

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
// `workflow-<kind>:<runId>`, see backend/src/workflowRuns/controlStep.ts) holds
// a run.lock. These are EXEMPT from the MAX_DEFER_MS force-restart backstop:
// unlike a short, re-runnable merge run, a workflow's Merge step holds the lock
// for the ENTIRE time its tasks take to commit (routinely far longer than 15
// min), and a workflow run is in-memory only — force-killing it wipes the run,
// strands the completed-but-unmerged tasks, and cascades the queue onto the next
// workflow (the exact "the second workflow continues" incident). So we keep
// deferring the restart until the workflow itself releases the lock. The user
// can cancel the workflow if they need the restart sooner.
export function workflowRunInFlight(opts) {
  return heldRunLockLabels(opts).some(isWorkflowLockLabel);
}

// Pure decision for the deferred-restart poll, extracted so the timing/label
// policy is unit-testable without real timers or filesystem. Actions:
//   'idle'          — nothing is deferred.
//   'apply'         — no operation holds a lock anymore → apply the deferred restart.
//   'hold-workflow' — a live workflow control step holds the lock → never force
//                     it; keep deferring (the poll logs this, throttled).
//   'force'         — a non-workflow op (merge-run/manual-merge) has held the
//                     lock past MAX_DEFER_MS → force the restart (it re-runs and
//                     auto-resumes on the next boot).
//   'hold'          — an op holds the lock but is still within the window.
export function classifyDeferAction({
  deferredSince,
  now,
  operationInFlight,
  workflowInFlight,
  maxDeferMs = MAX_DEFER_MS,
}) {
  if (!deferredSince) return 'idle';
  if (!operationInFlight) return 'apply';
  if (workflowInFlight) return 'hold-workflow';
  if (now - deferredSince > maxDeferMs) return 'force';
  return 'hold';
}

export function createRestartPolicy({
  restartBackend,
  // The one lock scan every decision derives from (records, see heldRunLocks).
  readHeldRunLocks,
  // Legacy boolean probes, kept for callers/tests that inject them; when
  // `readHeldRunLocks` is absent they are adapted into synthetic records.
  operationInFlight,
  workflowInFlight,
  readNewestDistMtime = () => newestDistMtimeMs(),
  readDistContentSignature = () => null,
  canRestart = () => true,
  needsBackendStart = () => false,
  deferBaselineUntilSpawn = false,
  now = () => Date.now(),
} = {}) {
  const scanRunLocks =
    readHeldRunLocks ??
    (operationInFlight || workflowInFlight
      ? () => {
          if (!(operationInFlight?.() ?? false)) return [];
          const workflow = workflowInFlight?.() ?? false;
          return [{ hash: '?', label: workflow ? 'workflow-?' : '?', pid: 0, startedAt: 0 }];
        }
      : () => heldRunLocks());
  let deferredSince = 0; // ms ts of the first deferred restart, or 0
  let distDebounceTimer = null;
  let deferPollTimer = null;
  let workflowDeferLoggedAt = 0; // last time we logged an ongoing workflow hold
  let holdLoggedAt = 0; // last time we logged an in-window non-workflow hold
  // Newest dist/ mtime as of the last APPLIED restart. A watch event whose
  // tree is no newer than this wrote nothing, so it must not restart.
  let distBaseline = null;
  // Newest mtime that justified a currently-deferred restart, so applying it
  // later advances the baseline to the change we actually acted on.
  let deferredDistMtime = null;
  let ignoredSince = 0;
  let ignoredCount = 0;
  let lastEvent = describeDistEvent(null, null);
  let contentBaseline = null;
  let stopped = false;
  let completedCompileSequence = 0;
  let lastCompletedContent = null;

  function captureDistBaseline() {
    return { mtime: readNewestDistMtime(), content: readDistContentSignature(), compileSequence: completedCompileSequence };
  }

  // Snapshot dist/'s current state as the "nothing new since here" mark. Called
  // by dev.mjs right before the watcher is armed (after the initial compile) so
  // the first real emit is still seen, and after every applied restart.
  function resetDistBaseline() {
    distBaseline = readNewestDistMtime();
    contentBaseline = readDistContentSignature();
  }

  function applyRestart(reason, newestSeen) {
    if (stopped || !canRestart()) return;
    const accepted = restartBackend(reason);
    if (accepted && !deferBaselineUntilSpawn) {
      deferredSince = 0;
      workflowDeferLoggedAt = 0;
      holdLoggedAt = 0;
      distBaseline =
        typeof newestSeen === 'number' ? newestSeen : readNewestDistMtime();
      deferredDistMtime = null;
      contentBaseline = readDistContentSignature();
    }
  }

  function onBackendSpawned(candidate) {
    // A successful kill request does not prove a new backend ran: kill can
    // later fail with EPERM. Commit the output baseline only on actual spawn.
    // The candidate was captured after asset copying, BEFORE spawnProcess.
    // A newer compile can start before the async 'spawn' event; its partial
    // output must not become the version we claim this backend is running.
    if (stopped) return;
    if (!candidate && !canRestart()) return;
    const applied = candidate ?? captureDistBaseline();
    distBaseline = applied.mtime;
    contentBaseline = applied.content;
    deferredSince = 0;
    deferredDistMtime = null;
    workflowDeferLoggedAt = 0;
    holdLoggedAt = 0;
    if (
      canRestart() && applied.compileSequence < completedCompileSequence &&
      !(lastCompletedContent !== null && lastCompletedContent === contentBaseline)
    ) onDistChanged(true);
  }

  // A dist/ watch event that corresponds to no actual write. Historically these
  // silently restarted the backend (killing in-flight runs) with a log line
  // that named neither the file nor the event.
  function noteIgnoredEvent() {
    ignoredCount += 1;
    const t = now();
    if (t - ignoredSince < IGNORED_EVENT_LOG_THROTTLE_MS) return;
    ignoredSince = t;
    console.log(
      `[lattice-backend] ignored ${ignoredCount} dist/ watch event(s) with no file write ` +
        `(latest: ${lastEvent}) — metadata-only (last-access/attribute/AV scan), not a rebuild. No restart.`,
    );
    ignoredCount = 0;
  }

  function onDistChanged(force = false) {
    // No emitted file is safe to restart against until the whole compile has
    // completed successfully. This also covers compiler downtime and repairs.
    if (stopped || !canRestart()) return;
    // Verify a real write BEFORE anything else, so a metadata-only event can
    // neither restart the backend nor arm a deferral that the poll later applies.
    const newest = readNewestDistMtime();
    if (!force && !needsBackendStart() && !shouldRestartForDist({ newest, baseline: distBaseline })) {
      noteIgnoredEvent();
      return;
    }
    if (typeof newest === 'number') {
      deferredDistMtime =
        deferredDistMtime === null ? newest : Math.max(deferredDistMtime, newest);
    }

    const locks = scanRunLocks();
    if (locks.length > 0) {
      if (!deferredSince) {
        deferredSince = now();
        holdLoggedAt = deferredSince;
        console.log(
          `[lattice-backend] dist/ changed (${lastEvent}) while a run.lock is held — deferring ` +
            'restart until it clears (the deferred-restart poll applies it once the run.lock clears). ' +
            `Held by: ${describeRunLocks(locks)}`,
        );
      }
      return; // the poll below handles "run finished" and the long-defer backstop
    }
    applyRestart(
      deferredSince ? 'run finished — applying deferred restart' : `dist/ changed (${lastEvent})`,
      newest,
    );
  }

  // Debounce dist/ change bursts — one tsc compile emits many files.
  function scheduleDistChanged(eventType, filename) {
    if (stopped) return;
    lastEvent = describeDistEvent(eventType, filename);
    if (distDebounceTimer) clearTimeout(distDebounceTimer);
    distDebounceTimer = setTimeout(() => {
      distDebounceTimer = null;
      onDistChanged();
    }, RESTART_DEBOUNCE_MS);
  }

  // Once a restart is deferred, the dist/ watcher won't necessarily fire
  // again, so poll: apply the deferred restart as soon as the run.lock
  // clears; force it after MAX_DEFER_MS only for a non-workflow op that has
  // wedged with the lock held; and keep deferring indefinitely while a
  // workflow control step legitimately holds it.
  function startDeferredPoll() {
    if (stopped || deferPollTimer) return;
    deferPollTimer = setInterval(() => {
      if (stopped || !canRestart()) return;
      // Idle: nothing deferred → nothing to decide. Scanning here anyway cost
      // two full per-project readdir/readFile/kill(0) sweeps every 3 s forever.
      if (!deferredSince) return;
      const locks = scanRunLocks();
      const action = classifyDeferAction({
        deferredSince,
        now: now(),
        operationInFlight: locks.length > 0,
        workflowInFlight: locks.some((lock) => isWorkflowLockLabel(lock.label)),
      });
      if (action === 'apply') {
        applyRestart('run finished — applying deferred restart', deferredDistMtime);
      } else if (action === 'force') {
        console.warn(
          `[lattice-backend] restart deferred for ${Math.round((now() - deferredSince) / 60000)} min — ` +
            `forcing it (an in-flight run will be interrupted and auto-resumed on the next boot; a merge run ` +
            `waiting on a conflict resolver loses that resolver session). Held by: ${describeRunLocks(locks)}`,
        );
        applyRestart('forced after a long defer', deferredDistMtime);
      } else if (action === 'hold-workflow') {
        const at = now();
        // Only surface this once the wait is long enough to be surprising, then
        // throttle — a short workflow that finishes inside the window just
        // 'apply's above and never logs.
        if (
          at - deferredSince > MAX_DEFER_MS &&
          at - workflowDeferLoggedAt > WORKFLOW_DEFER_RELOG_MS
        ) {
          workflowDeferLoggedAt = at;
          console.log(
            `[lattice-backend] restart held ${Math.round((at - deferredSince) / 60000)} min — a workflow control ` +
              `step (start/merge/push) is running and holds the run.lock. Not force-restarting (that would ` +
              `interrupt the workflow and strand its tasks). The restart applies when the workflow finishes; ` +
              `cancel the workflow run to restart sooner. Held by: ${describeRunLocks(locks)}`,
          );
        }
      } else if (action === 'hold') {
        // Inside the window: say WHICH lock is holding the restart, once a
        // minute, so a stale/recycled lock is attributable rather than a
        // silent 15-min wait followed by an unexplained force.
        const at = now();
        if (at - holdLoggedAt >= HOLD_LOG_THROTTLE_MS) {
          holdLoggedAt = at;
          console.log(
            `[lattice-backend] restart still deferred (${Math.round((at - deferredSince) / 60000)} min) — ` +
              `run.lock held by: ${describeRunLocks(locks)}`,
          );
        }
      }
      // 'idle' → nothing to do
    }, DEFERRED_RESTART_POLL_MS);
    deferPollTimer.unref();
  }

  function stopDeferredPoll() {
    stopped = true;
    if (distDebounceTimer) clearTimeout(distDebounceTimer);
    distDebounceTimer = null;
    if (deferPollTimer) clearInterval(deferPollTimer);
    deferPollTimer = null;
  }

  function onCompileSucceeded() {
    if (stopped || !canRestart()) return;
    const current = readDistContentSignature();
    completedCompileSequence++;
    lastCompletedContent = current;
    if (!needsBackendStart() && current !== null && current === contentBaseline) {
      // Includes the cold watch-mode re-emit, recovery with unchanged output,
      // and a deferred edit reverted to the currently-running backend's bytes.
      distBaseline = readNewestDistMtime();
      deferredSince = 0;
      deferredDistMtime = null;
      workflowDeferLoggedAt = 0;
      holdLoggedAt = 0;
      return;
    }
    lastEvent = 'successful TypeScript compilation';
    // Catch up even if the compiler was down, metadata timestamps collided,
    // or the native dist watcher missed the event. Existing run locks still
    // control whether the verified rebuild may restart the backend now.
    onDistChanged(true);
  }

  return {
    onDistChanged,
    scheduleDistChanged,
    resetDistBaseline,
    startDeferredPoll,
    stopDeferredPoll,
    onCompileSucceeded,
    onBackendSpawned,
    captureDistBaseline,
  };
}
