// Timer lifecycle for the staleness sweep. Kept module-scoped so the
// start/stop calls in server/startup.ts don't have to pass an opaque handle
// around. The scan itself lives in `./sweep.ts`.

import { IN_PROGRESS_SWEEP_INTERVAL_MS, MIN_AGE_MS } from './config.js';
import { sweepStuckInProgressTasks } from './sweep.js';

let sweepTimer: NodeJS.Timeout | null = null;

export function startInProgressSweepLoop(
  intervalMs: number = IN_PROGRESS_SWEEP_INTERVAL_MS,
): void {
  if (sweepTimer) return;
  // First pass after a short delay so it doesn't pile onto boot recovery.
  sweepTimer = setInterval(() => {
    sweepStuckInProgressTasks().catch((err) => {
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
