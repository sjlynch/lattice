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
// Don't defer a restart forever if a SHORT, re-runnable operation (a merge run
// or a manual /merge) somehow wedges with the lock held — after this long,
// restart anyway (the run is interrupted, then auto-resumed on the next boot).
// A workflow control step is deliberately exempt from this (see
// `workflowRunInFlight` / `classifyDeferAction`).
export const MAX_DEFER_MS = 15 * 60 * 1000;
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

// Labels of every per-project run.lock currently held by a LIVE process, across
// all projects. Cheap — only read on a dist/ change or the poll. A dead-PID
// lock (leaked by a killed process) is ignored: it is not an in-flight
// operation, and boot recovery reclaims it.
export function heldRunLockLabels({ perProjectDir = PER_PROJECT_DIR, isPidAlive = pidAlive } = {}) {
  let hashes;
  try {
    hashes = fs.readdirSync(perProjectDir);
  } catch {
    return []; // dir doesn't exist yet → nothing running
  }
  const labels = [];
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
    if (body && typeof body.pid === 'number' && isPidAlive(body.pid)) {
      labels.push(typeof body.label === 'string' ? body.label : '');
    }
  }
  return labels;
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
  return heldRunLockLabels(opts).some((label) => label.startsWith('workflow-'));
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
  operationInFlight = () => repoOperationInFlight(),
  workflowInFlight = () => workflowRunInFlight(),
  readNewestDistMtime = () => newestDistMtimeMs(),
  now = () => Date.now(),
} = {}) {
  let deferredSince = 0; // ms ts of the first deferred restart, or 0
  let distDebounceTimer = null;
  let deferPollTimer = null;
  let workflowDeferLoggedAt = 0; // last time we logged an ongoing workflow hold
  // Newest dist/ mtime as of the last APPLIED restart. A watch event whose
  // tree is no newer than this wrote nothing, so it must not restart.
  let distBaseline = null;
  // Newest mtime that justified a currently-deferred restart, so applying it
  // later advances the baseline to the change we actually acted on.
  let deferredDistMtime = null;
  let ignoredSince = 0;
  let ignoredCount = 0;
  let lastEvent = describeDistEvent(null, null);

  // Snapshot dist/'s current state as the "nothing new since here" mark. Called
  // by dev.mjs right before the watcher is armed (after the initial compile) so
  // the first real emit is still seen, and after every applied restart.
  function resetDistBaseline() {
    distBaseline = readNewestDistMtime();
  }

  function applyRestart(reason, newestSeen) {
    const accepted = restartBackend(reason);
    if (accepted) {
      deferredSince = 0;
      workflowDeferLoggedAt = 0;
      distBaseline =
        typeof newestSeen === 'number' ? newestSeen : readNewestDistMtime();
      deferredDistMtime = null;
    }
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

  function onDistChanged() {
    // Verify a real write BEFORE anything else, so a metadata-only event can
    // neither restart the backend nor arm a deferral that the poll later applies.
    const newest = readNewestDistMtime();
    if (!shouldRestartForDist({ newest, baseline: distBaseline })) {
      noteIgnoredEvent();
      return;
    }
    if (typeof newest === 'number') {
      deferredDistMtime =
        deferredDistMtime === null ? newest : Math.max(deferredDistMtime, newest);
    }

    if (operationInFlight()) {
      if (!deferredSince) {
        deferredSince = now();
        console.log(
          `[lattice-backend] dist/ changed (${lastEvent}) during a merge/merge-all or workflow run — deferring ` +
            'restart until it finishes (the deferred-restart poll applies it once the run.lock clears).',
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
    if (deferPollTimer) return;
    deferPollTimer = setInterval(() => {
      const action = classifyDeferAction({
        deferredSince,
        now: now(),
        operationInFlight: operationInFlight(),
        workflowInFlight: workflowInFlight(),
      });
      if (action === 'apply') {
        applyRestart('run finished — applying deferred restart', deferredDistMtime);
      } else if (action === 'force') {
        console.warn(
          `[lattice-backend] restart deferred for ${Math.round((now() - deferredSince) / 60000)} min — ` +
            `forcing it (an in-flight run will be interrupted and auto-resumed on the next boot).`,
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
              `cancel the workflow run to restart sooner.`,
          );
        }
      }
      // 'idle' / 'hold' → nothing to do
    }, DEFERRED_RESTART_POLL_MS);
    deferPollTimer.unref();
  }

  function stopDeferredPoll() {
    if (!deferPollTimer) return;
    clearInterval(deferPollTimer);
    deferPollTimer = null;
  }

  return {
    onDistChanged,
    scheduleDistChanged,
    resetDistBaseline,
    startDeferredPoll,
    stopDeferredPoll,
  };
}
