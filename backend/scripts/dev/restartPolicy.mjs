import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const PER_PROJECT_DIR = path.join(os.homedir(), '.lattice', 'per-project');
export const RESTART_DEBOUNCE_MS = 250;
export const DEFERRED_RESTART_POLL_MS = 3000;
// Don't defer a restart forever if a run somehow wedges with the lock
// held — after this long, restart anyway (the run is interrupted, then
// auto-resumed on the next boot).
export const MAX_DEFER_MS = 15 * 60 * 1000;

export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return Boolean(err) && err.code !== 'ESRCH'; // EPERM etc → assume alive
  }
}

// True if any Lattice process holds a per-project run.lock (a merge run
// or a manual /merge). Cheap — only read on a dist/ change or the poll.
export function repoOperationInFlight({ perProjectDir = PER_PROJECT_DIR, isPidAlive = pidAlive } = {}) {
  let hashes;
  try {
    hashes = fs.readdirSync(perProjectDir);
  } catch {
    return false; // dir doesn't exist yet → nothing running
  }
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
    if (body && typeof body.pid === 'number' && isPidAlive(body.pid)) return true;
  }
  return false;
}

export function createRestartPolicy({
  restartBackend,
  operationInFlight = () => repoOperationInFlight(),
} = {}) {
  let deferredSince = 0; // ms ts of the first deferred restart, or 0
  let distDebounceTimer = null;
  let deferPollTimer = null;

  function applyRestart(reason) {
    const accepted = restartBackend(reason);
    if (accepted) deferredSince = 0;
  }

  function onDistChanged() {
    if (operationInFlight()) {
      if (!deferredSince) {
        deferredSince = Date.now();
        console.log(
          '[lattice-backend] dist/ changed during a merge/merge-all run — deferring restart until it finishes ' +
            '(the deferred-restart poll applies it once the run.lock clears).',
        );
      }
      return; // the poll below handles "run finished" and the long-defer backstop
    }
    applyRestart(deferredSince ? 'merge run finished — applying deferred restart' : 'dist/ changed');
  }

  // Debounce dist/ change bursts — one tsc compile emits many files.
  function scheduleDistChanged() {
    if (distDebounceTimer) clearTimeout(distDebounceTimer);
    distDebounceTimer = setTimeout(() => {
      distDebounceTimer = null;
      onDistChanged();
    }, RESTART_DEBOUNCE_MS);
  }

  // Once a restart is deferred, the dist/ watcher won't necessarily fire
  // again, so poll: apply the deferred restart as soon as the run.lock
  // clears, and — as a backstop against a wedged run holding the lock
  // forever — force it after MAX_DEFER_MS regardless.
  function startDeferredPoll() {
    if (deferPollTimer) return;
    deferPollTimer = setInterval(() => {
      if (!deferredSince) return;
      if (!operationInFlight()) {
        applyRestart('merge run finished — applying deferred restart');
      } else if (Date.now() - deferredSince > MAX_DEFER_MS) {
        console.warn(
          `[lattice-backend] restart deferred for ${Math.round((Date.now() - deferredSince) / 60000)} min — ` +
            `forcing it (an in-flight run will be interrupted and auto-resumed on the next boot).`,
        );
        applyRestart('forced after a long defer');
      }
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
    startDeferredPoll,
    stopDeferredPoll,
  };
}
