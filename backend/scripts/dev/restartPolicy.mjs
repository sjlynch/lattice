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
// run is interrupted, then auto-resumed on the next boot). This is the
// backstop for a WEDGED holder. "Re-runnable" is not "short", though: a merge
// run parked on a conflict-resolver agent or the post-merge-hook agent holds
// the lock for as long as that agent works. Such a run is EXEMPT while the
// backend reports it parked on a LIVE agent (`queryLockHolders` →
// GET /api/internal/restart-drain/lock-holders, see
// backend/src/restartDrain/lockHolders.ts): forcing then would interrupt a
// working agent for nothing. (The resolver's pty lives in the detached
// terminal-server and would survive, and the resumed run re-attaches it — but
// the interruption is still friction.) A backend that can't be asked gets the
// old behaviour: force. A workflow control step is exempt outright (see
// `workflowRunInFlight` / `classifyDeferAction`).
export const MAX_DEFER_MS = 15 * 60 * 1000;
// Once the last run.lock clears, wait this long before even starting the
// restart handshake. A workflow control step releases its lock BEFORE its
// advance dispatches the next step (backend/src/workflowRuns/controlStep.ts),
// and the frontend's workflow queue starts the next workflow the moment one
// finishes — a restart applied on the first lock-free poll landed in exactly
// those hand-offs. Belt and braces: the backend's drain (restartHandshake.mjs)
// also waits out every in-flight transition it knows about.
export const LOCK_SETTLE_MS = 5 * 1000;
// A "parked on a live agent" answer is trusted for this long before the
// backend is asked again (the force decision re-evaluates every poll).
export const PARKED_PROBE_TTL_MS = 60 * 1000;
// Re-log an ongoing parked-holder hold at most this often.
export const PARKED_HOLD_RELOG_MS = 5 * 60 * 1000;
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

// Pure decision for the deferred-restart poll, extracted so the timing/label
// policy is unit-testable without real timers or filesystem. Actions:
//   'idle'          — nothing is deferred.
//   'settle'        — the locks cleared less than `settleMs` ago (the last scan
//                     that saw one was at `lastLockSeenAt`) → wait a little
//                     longer before applying (see LOCK_SETTLE_MS).
//   'apply'         — no operation holds a lock anymore → apply the deferred restart.
//   'hold-workflow' — a live workflow control step holds the lock → never force
//                     it; keep deferring (the poll logs this, throttled).
//   'hold-parked'   — a non-workflow op is past MAX_DEFER_MS but the backend
//                     reports it parked on a live agent (a conflict resolver /
//                     the post-merge hook) → keep deferring.
//   'force'         — a non-workflow op (merge-run/manual-merge) has held the
//                     lock past MAX_DEFER_MS and is not known to be parked on
//                     a live agent → force the restart (it re-runs and
//                     auto-resumes on the next boot).
//   'hold'          — an op holds the lock but is still within the window.
// `lastLockSeenAt` / `settleMs` / `parkedOnLiveAgent` are optional: without
// them the decision is the original one (apply at once, force at the window).
export function classifyDeferAction({
  deferredSince,
  now,
  operationInFlight,
  workflowInFlight,
  maxDeferMs = MAX_DEFER_MS,
  lastLockSeenAt = 0,
  settleMs = 0,
  parkedOnLiveAgent = false,
}) {
  if (!deferredSince) return 'idle';
  if (!operationInFlight) {
    return settleMs > 0 && lastLockSeenAt > 0 && now - lastLockSeenAt < settleMs ? 'settle' : 'apply';
  }
  if (workflowInFlight) return 'hold-workflow';
  if (now - deferredSince > maxDeferMs) return parkedOnLiveAgent ? 'hold-parked' : 'force';
  return 'hold';
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

function parkedDetail(locks, report) {
  if (!report) return 'no answer';
  if (!report.ok) return report.why;
  const details = locks
    .map((lock) => report.holders.find((h) => h && h.hash === lock.hash))
    .filter(Boolean)
    .map((h) => `${h.hash}: ${h.detail || h.parkedOn || 'not parked'}`);
  return details.length ? details.join('; ') : 'the backend reports no agent the lock holder is waiting on';
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
  // The restart handshake (restartHandshake.mjs). All optional: without
  // `prepareRestart` a restart is applied synchronously, exactly as before.
  //   prepareRestart(reason)  → Promise<{ok, ready, pending, waitedMs} | {ok:false, why}>
  //   cancelRestartDrain(why) → release a drain we won't follow with a restart
  //   queryLockHolders()      → Promise<{ok, pid, holders} | {ok:false, why}>
  prepareRestart,
  cancelRestartDrain,
  queryLockHolders,
  lockSettleMs = LOCK_SETTLE_MS,
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
  // Last time a scan saw ANY live run.lock (0 = never) — the settle clock.
  let lastLockSeenAt = 0;
  // A restart handshake is in flight; further triggers coalesce into it (the
  // respawn loads whatever dist/ holds by then).
  let preparing = false;
  // Cached "are the lock holders parked on live agents?" answer, keyed by the
  // exact set of locks it was asked about.
  let parkedProbe = null; // { key, at, report }
  let parkedProbeInFlight = false;
  let parkedHoldLoggedAt = 0;
  // Bumped on every backend spawn. A handshake that straddles a spawn (the
  // poll can start one in the instant between a kill and the respawn) must not
  // then restart the NEW backend on the old decision.
  let spawnGeneration = 0;

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

  function commitRestart(reason, newestSeen) {
    const accepted = restartBackend(reason);
    if (accepted && !deferBaselineUntilSpawn) {
      deferredSince = 0;
      workflowDeferLoggedAt = 0;
      holdLoggedAt = 0;
      parkedHoldLoggedAt = 0;
      distBaseline =
        typeof newestSeen === 'number' ? newestSeen : readNewestDistMtime();
      deferredDistMtime = null;
      contentBaseline = readDistContentSignature();
    }
    return accepted;
  }

  function releaseDrain(why) {
    if (!cancelRestartDrain) return;
    Promise.resolve()
      .then(() => cancelRestartDrain(why))
      .catch(() => { /* best-effort: the backend's drain TTL covers a lost cancel */ });
  }

  // Apply a restart. With a handshake configured and a backend running, first
  // ask it to drain (stop admitting new work, let in-flight transitions land,
  // flush state) and restart once it answers — or fails to (fail open).
  function applyRestart(reason, newestSeen, { forced = false } = {}) {
    if (stopped || !canRestart()) return;
    // No backend running (crashed, or never started): nothing to drain.
    if (!prepareRestart || needsBackendStart()) {
      commitRestart(reason, newestSeen);
      return;
    }
    if (preparing) return;
    preparing = true;
    const generation = spawnGeneration;
    Promise.resolve()
      .then(() => prepareRestart(reason))
      .then(
        (result) => result,
        (err) => ({ ok: false, why: `handshake threw: ${err?.message ?? err}` }),
      )
      .then((result) => {
        preparing = false;
        onPrepared(result, reason, newestSeen, forced, generation);
      });
  }

  function onPrepared(result, reason, newestSeen, forced, generation) {
    if (stopped) return; // shutting down — that kills the backend anyway
    if (generation !== spawnGeneration) {
      // A backend was (re)spawned while we asked; this decision was about the
      // one before it. Anything still pending re-triggers on its own.
      releaseDrain('a new backend spawned during the handshake');
      return;
    }
    if (!canRestart()) {
      // A compile started while the backend drained; its successful completion
      // re-triggers the restart (onCompileSucceeded). Don't leave it frozen.
      console.log('[lattice-backend] restart postponed — a TypeScript compile started while the backend drained');
      releaseDrain('a compile started; restart postponed');
      return;
    }
    if (!forced) {
      // The drain stops NEW run-lock acquisitions, but one taken between our
      // lock scan and the drain starting is still a run we'd interrupt.
      const locks = scanRunLocks();
      if (locks.length > 0) {
        lastLockSeenAt = now();
        if (!deferredSince) {
          deferredSince = now();
          holdLoggedAt = deferredSince;
        }
        console.log(
          '[lattice-backend] a run.lock was taken while the backend drained — releasing the drain and ' +
            `deferring the restart until it clears. Held by: ${describeRunLocks(locks)}`,
        );
        releaseDrain('a run.lock was taken; restart deferred');
        return;
      }
    }
    if (!result || !result.ok) {
      console.warn(
        `[lattice-backend] restart handshake unavailable (${result?.why ?? 'no answer'}) — ` +
          'restarting without draining the backend',
      );
    } else if (!result.ready) {
      console.warn(
        `[lattice-backend] backend did not settle within ${Math.round(result.waitedMs / 1000)} s ` +
          `(still in flight: ${result.pending.join('; ') || 'unknown'}) — restarting anyway`,
      );
    } else {
      console.log(`[lattice-backend] backend drained for restart in ${result.waitedMs} ms`);
    }
    const seen = [newestSeen, deferredDistMtime].filter((v) => typeof v === 'number');
    const accepted = commitRestart(reason, seen.length ? Math.max(...seen) : newestSeen);
    // Nothing is going to kill the drained backend after all — un-drain it
    // now rather than leave it refusing work until the TTL.
    if (!accepted) releaseDrain('restart was not applied');
  }

  function lockSetKey(locks) {
    return locks.map((lock) => `${lock.hash}:${lock.pid}:${lock.startedAt}`).sort().join('|');
  }

  // The cached parked answer for exactly this lock set, if fresh; else null.
  function freshParkedReport(locks) {
    if (!parkedProbe) return null;
    if (parkedProbe.key !== lockSetKey(locks)) return null;
    if (now() - parkedProbe.at >= PARKED_PROBE_TTL_MS) return null;
    return parkedProbe.report;
  }

  function startParkedProbe(locks) {
    if (parkedProbeInFlight || !queryLockHolders) return;
    parkedProbeInFlight = true;
    const key = lockSetKey(locks);
    Promise.resolve()
      .then(() => queryLockHolders())
      .then(
        (report) => report,
        (err) => ({ ok: false, why: `lock-holder query threw: ${err?.message ?? err}` }),
      )
      .then((report) => {
        parkedProbeInFlight = false;
        parkedProbe = { key, at: now(), report: report ?? { ok: false, why: 'no answer' } };
      });
  }

  function onBackendSpawned(candidate) {
    // A successful kill request does not prove a new backend ran: kill can
    // later fail with EPERM. Commit the output baseline only on actual spawn.
    // The candidate was captured after asset copying, BEFORE spawnProcess.
    // A newer compile can start before the async 'spawn' event; its partial
    // output must not become the version we claim this backend is running.
    if (stopped) return;
    // Any handshake started before this spawn was about the PREVIOUS backend.
    spawnGeneration += 1;
    if (!candidate && !canRestart()) return;
    const applied = candidate ?? captureDistBaseline();
    distBaseline = applied.mtime;
    contentBaseline = applied.content;
    deferredSince = 0;
    deferredDistMtime = null;
    workflowDeferLoggedAt = 0;
    holdLoggedAt = 0;
    parkedHoldLoggedAt = 0;
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
      lastLockSeenAt = now();
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
    if (lockSettleMs > 0 && lastLockSeenAt > 0 && now() - lastLockSeenAt < lockSettleMs) {
      // A lock cleared moments ago — its run may still be handing off (see
      // LOCK_SETTLE_MS). Arm the deferral; the poll applies it once settled.
      if (!deferredSince) {
        deferredSince = now();
        holdLoggedAt = deferredSince;
        console.log(
          `[lattice-backend] dist/ changed (${lastEvent}) just after a run.lock cleared — ` +
            `letting the run settle for ${Math.round(lockSettleMs / 1000)} s before restarting`,
        );
      }
      return;
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
      // A handshake is already in flight; it decides (and re-defers if needed).
      if (preparing) return;
      const locks = scanRunLocks();
      if (locks.length > 0) lastLockSeenAt = now();
      const parkedReport = locks.length > 0 ? freshParkedReport(locks) : null;
      const action = classifyDeferAction({
        deferredSince,
        now: now(),
        operationInFlight: locks.length > 0,
        workflowInFlight: locks.some((lock) => isWorkflowLockLabel(lock.label)),
        lastLockSeenAt,
        settleMs: lockSettleMs,
        parkedOnLiveAgent: locksParkedOnLiveAgents(locks, parkedReport),
      });
      if (action === 'settle') {
        // Lock just cleared — give the run's hand-off a few seconds.
      } else if (action === 'apply') {
        applyRestart('run finished — applying deferred restart', deferredDistMtime);
      } else if (action === 'force') {
        // Before forcing, ask the backend whether the holder is merely parked
        // on a live agent (then it's not wedged). The answer arrives async;
        // decide on the next tick.
        if (queryLockHolders && !parkedReport) {
          startParkedProbe(locks);
          return;
        }
        console.warn(
          `[lattice-backend] restart deferred for ${Math.round((now() - deferredSince) / 60000)} min — ` +
            'forcing it (an in-flight run will be interrupted and auto-resumed on the next boot). ' +
            `Held by: ${describeRunLocks(locks)}` +
            (queryLockHolders ? ` — not parked on a live agent: ${parkedDetail(locks, parkedReport)}` : ''),
        );
        applyRestart('forced after a long defer', deferredDistMtime, { forced: true });
      } else if (action === 'hold-parked') {
        const at = now();
        if (!parkedHoldLoggedAt || at - parkedHoldLoggedAt >= PARKED_HOLD_RELOG_MS) {
          parkedHoldLoggedAt = at;
          console.log(
            `[lattice-backend] restart held ${Math.round((at - deferredSince) / 60000)} min — the run.lock ` +
              'holder is parked on a live agent, not wedged; not force-restarting (that would interrupt it). ' +
              `${parkedDetail(locks, parkedReport)}. Held by: ${describeRunLocks(locks)}`,
          );
        }
        // Keep the answer current: re-ask once it goes stale.
        if (now() - (parkedProbe?.at ?? 0) >= PARKED_PROBE_TTL_MS / 2) startParkedProbe(locks);
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
      parkedHoldLoggedAt = 0;
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
