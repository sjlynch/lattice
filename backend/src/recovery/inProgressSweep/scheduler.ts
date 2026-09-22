// Timer lifecycle for the staleness sweep. Kept module-scoped so the
// start/stop calls in server/startup.ts don't have to pass an opaque handle
// around. The scan itself lives in `./sweep.ts`.

import { IN_PROGRESS_SWEEP_INTERVAL_MS, MIN_AGE_MS } from './config.js';
import { sweepStuckInProgressTasks } from './sweep.js';

let sweepTimer: NodeJS.Timeout | null = null;
// A pass spawns one git per eligible task (plus a terminal-server probe); a
// wedged git or a big board can push it past the interval, and without this
// guard a second pass would start on top of the first (same guard shape as
// spawnQueue/poll.ts's `pollInProgress`).
let sweepInProgress = false;

// `sweep` is an injectable seam for the overlap test; production always uses
// the real sweep. Returns false when a tick was skipped because one is live.
export async function runInProgressSweepTick(
  sweep: () => Promise<unknown> = sweepStuckInProgressTasks,
): Promise<boolean> {
  if (sweepInProgress) return false;
  sweepInProgress = true;
  try {
    await sweep();
  } finally {
    sweepInProgress = false;
  }
  return true;
}

export function startInProgressSweepLoop(
  intervalMs: number = IN_PROGRESS_SWEEP_INTERVAL_MS,
): void {
  if (sweepTimer) return;
  // First pass after one full interval so it doesn't pile onto boot recovery.
  sweepTimer = setInterval(() => {
    runInProgressSweepTick().catch((err) => {
      console.error('[in-progress-sweep] tick threw:', err);
    });
  }, intervalMs);
  // Don't keep the event loop alive — the HTTP server already does that.
  if (typeof sweepTimer.unref === 'function') sweepTimer.unref();
  console.log(
    `[in-progress-sweep] started; interval=${intervalMs}ms, minAge=${MIN_AGE_MS}ms`,
  );
}

export function stopInProgressSweepLoop(): void {
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
}
