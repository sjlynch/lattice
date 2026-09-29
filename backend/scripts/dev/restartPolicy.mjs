import {
  describeDistEvent,
  newestDistMtimeMs,
} from './distSignature.mjs';
import { createParkedProbeCache } from './parkedProbe.mjs';
import { createRestartOutputState } from './restartOutputState.mjs';
import {
  describeRunLocks,
  heldRunLocks,
  isWorkflowLockLabel,
  locksParkedOnLiveAgents,
  parkedDetail,
} from './runLocks.mjs';

// run.lock discovery lives in runLocks.mjs; re-exported so every existing
// importer of this module (scripts/orchestrate.mjs, the __tests__ suite) keeps
// working unchanged.
export {
  PER_PROJECT_DIR,
  PROCESS_START_FUZZ_MS,
  pidAlive,
  processStartTimeMs,
  isWorkflowLockLabel,
  heldRunLocks,
  heldRunLockLabels,
  describeRunLocks,
  repoOperationInFlight,
  workflowRunInFlight,
  locksParkedOnLiveAgents,
} from './runLocks.mjs';

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
// While a workflow legitimately holds the lock past MAX_DEFER_MS, re-log the
// "still holding the restart" notice at most this often so a long defer isn't a
// silent mystery, without spamming the 3s poll.
export const WORKFLOW_DEFER_RELOG_MS = 5 * 60 * 1000;

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
  const outputState = createRestartOutputState({ readNewestDistMtime, readDistContentSignature });
  // Newest mtime that justified a currently-deferred restart, so applying it
  // later advances the baseline to the change we actually acted on.
  let deferredDistMtime = null;
  let ignoredSince = 0;
  let ignoredCount = 0;
  let lastEvent = describeDistEvent(null, null);
  let stopped = false;
  // Last time a scan saw ANY live run.lock (0 = never) — the settle clock.
  let lastLockSeenAt = 0;
  // A restart handshake is in flight; further triggers coalesce into it (the
  // respawn loads whatever dist/ holds by then).
  let preparing = false;
  const parkedProbeCache = createParkedProbeCache({ now, queryLockHolders, ttlMs: PARKED_PROBE_TTL_MS });
  let parkedHoldLoggedAt = 0;
  // Bumped on every backend spawn. A handshake that straddles a spawn (the
  // poll can start one in the instant between a kill and the respawn) must not
  // then restart the NEW backend on the old decision.
  let spawnGeneration = 0;

  function captureDistBaseline() {
    return outputState.captureDistBaseline();
  }

  // Snapshot dist/'s current state as the "nothing new since here" mark. Called
  // by dev.mjs right before the watcher is armed (after the initial compile) so
  // the first real emit is still seen, and after every applied restart.
  function resetDistBaseline() {
    outputState.resetDistBaseline();
  }

  // Forget any deferred restart and its log throttles (it was applied, or
  // there is nothing left to apply).
  function clearDeferral() {
    deferredSince = 0;
    deferredDistMtime = null;
    workflowDeferLoggedAt = 0;
    holdLoggedAt = 0;
    parkedHoldLoggedAt = 0;
  }

  // Start the defer clock unless a restart is already deferred. True when this
  // call armed it (the caller logs why, once).
  function armDeferral() {
    if (deferredSince) return false;
    deferredSince = now();
    holdLoggedAt = deferredSince;
    return true;
  }

  function commitRestart(reason, newestSeen) {
    const accepted = restartBackend(reason);
    if (accepted && !deferBaselineUntilSpawn) {
      clearDeferral();
      outputState.commitRestartBaseline(newestSeen);
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
        armDeferral();
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
    outputState.commitSpawnBaseline(applied);
    clearDeferral();
    if (canRestart() && outputState.needsCompileCatchUp(applied)) onDistChanged(true);
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
    if (!force && !needsBackendStart() && !outputState.hasDistChange(newest)) {
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
      if (armDeferral()) {
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
      if (armDeferral()) {
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

  // One handler per non-trivial `classifyDeferAction` result of a deferred
  // poll tick ('settle' / 'idle' do nothing), each given that tick's lock scan
  // and the fresh parked report (or null).
  function onDeferApply() {
    applyRestart('run finished — applying deferred restart', deferredDistMtime);
  }

  function onDeferForce(locks, parkedReport) {
    // Before forcing, ask the backend whether the holder is merely parked
    // on a live agent (then it's not wedged). The answer arrives async;
    // decide on the next tick.
    if (queryLockHolders && !parkedReport) {
      parkedProbeCache.start(locks);
      return;
    }
    console.warn(
      `[lattice-backend] restart deferred for ${Math.round((now() - deferredSince) / 60000)} min — ` +
        'forcing it (an in-flight run will be interrupted and auto-resumed on the next boot). ' +
        `Held by: ${describeRunLocks(locks)}` +
        (queryLockHolders ? ` — not parked on a live agent: ${parkedDetail(locks, parkedReport)}` : ''),
    );
    applyRestart('forced after a long defer', deferredDistMtime, { forced: true });
  }

  function onDeferHoldParked(locks, parkedReport) {
    const at = now();
    if (!parkedHoldLoggedAt || at - parkedHoldLoggedAt >= PARKED_HOLD_RELOG_MS) {
      parkedHoldLoggedAt = at;
      console.log(
        `[lattice-backend] restart held ${Math.round((at - deferredSince) / 60000)} min — the run.lock ` +
          'holder is parked on a live agent, not wedged; not force-restarting (that would interrupt it). ' +
          `${parkedDetail(locks, parkedReport)}. Held by: ${describeRunLocks(locks)}`,
      );
    }
    // Keep the answer current: re-ask at half its TTL during a parked hold.
    parkedProbeCache.refreshIfDue(locks);
  }

  function onDeferHoldWorkflow(locks) {
    const at = now();
    // Only surface this once the wait is long enough to be surprising, then
    // throttle — a short workflow that finishes inside the window just
    // 'apply's (onDeferApply) and never logs.
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
  }

  function onDeferHold(locks) {
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
      const parkedReport = locks.length > 0 ? parkedProbeCache.freshReport(locks) : null;
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
        onDeferApply();
      } else if (action === 'force') {
        onDeferForce(locks, parkedReport);
      } else if (action === 'hold-parked') {
        onDeferHoldParked(locks, parkedReport);
      } else if (action === 'hold-workflow') {
        onDeferHoldWorkflow(locks);
      } else if (action === 'hold') {
        onDeferHold(locks);
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
    const current = outputState.recordCompletedCompile();
    if (!needsBackendStart() && outputState.isUnchangedCompile(current)) {
      // Includes the cold watch-mode re-emit, recovery with unchanged output,
      // and a deferred edit reverted to the currently-running backend's bytes.
      outputState.resetMtimeBaseline();
      clearDeferral();
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
