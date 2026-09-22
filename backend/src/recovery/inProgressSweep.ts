// Periodic staleness sweep for `in_progress` tasks. Public facade — the
// implementation is split under `./inProgressSweep/` by concern:
//   - `scheduler.ts`   — timer lifecycle (start/stop the loop).
//   - `sweep.ts`       — project/task scanning + per-verdict accounting.
//   - `eligibility.ts` — the skip/complete decision (discriminated union).
//   - `complete.ts`    — the auto-complete mutation (+ Pi sentinel diagnostic).
//   - `config.ts`      — the age gate / interval knobs.
//
// The Pi extension and the model's explicit `/complete` curl are both best-
// effort — if Pi crashes, OOMs, or exits with a non-`quit` reason that the
// extension's gate filters out, the task can sit in `in_progress` with a
// committed branch but a dead PTY forever. The boot-time `recoverOrphanedTasks`
// only catches one class of related failure (ready_to_merge with deleted
// branch). This sweep complements it from the other end: in_progress tasks
// whose PTY is dead AND whose branch has a commit get auto-completed.
//
// All eligibility conditions (see `eligibility.ts`) must hold for a task to be
// auto-completed. The transition uses the same crash-safe (disk-before-cache)
// update as the normal `/complete` path, after re-reading the task.

export {
  startInProgressSweepLoop,
  stopInProgressSweepLoop,
} from './inProgressSweep/scheduler.js';
export {
  sweepStuckInProgressTasks,
  type SweepResult,
} from './inProgressSweep/sweep.js';
export { IN_PROGRESS_SWEEP_INTERVAL_MS } from './inProgressSweep/config.js';
