// Tunable knobs for the in-progress staleness sweep, kept in one place so the
// scheduler (loop timing) and the eligibility check (age gate) can share them.

// Minimum `in_progress` age before a task is eligible for an auto-flip.
// Tasks younger than this are presumed mid-startup; the model may not have
// printed its first prompt yet.
export const MIN_AGE_MS = 5 * 60 * 1000;

// How often to run the sweep. Pi sessions can wedge silently for tens of
// minutes before the user notices; one pass per minute is cheap and
// catches things at most ~1 min after the PTY actually dies.
export const IN_PROGRESS_SWEEP_INTERVAL_MS = 60 * 1000;
