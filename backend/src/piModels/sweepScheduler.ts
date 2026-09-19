// Scheduling policy for a periodic "sweep" that many callers can trigger at
// once — extracted from autoDiscover.ts because the interesting behaviour here
// is the scheduling, not the probing, and inline it could only be exercised by
// standing up a real server and real config files.
//
// Every rule earns its place:
//
//   JOIN an in-flight sweep, even inside the TTL window. A caller asks for a
//   refresh so it can READ the result; answering "throttled" while a sweep is
//   mid-write hands it state that is about to change underneath it.
//
//   THROTTLE by TTL only when nothing is running — otherwise a harness dropdown
//   opening re-probes every endpoint on every render.
//
//   FORCE never adopts an in-flight sweep. Whoever forces has just changed the
//   INPUTS (a settings save added an endpoint); the running sweep read the
//   provider list before that change, so adopting its result would drop the new
//   endpoint until the TTL expired — precisely the "I added it and see no
//   models" failure this whole feature exists to remove.
//
//   BOUND the wait without bounding the work. An HTTP handler must not sit
//   behind a probe serving out its full timeout against a host that is down;
//   the sweep keeps running and its result lands for the next caller.

export type SweepScheduler = {
  run: (opts?: { force?: boolean; maxWaitMs?: number }) => Promise<boolean>;
  // Whether a sweep is currently running — for assertions and diagnostics.
  isRunning: () => boolean;
};

export function createSweepScheduler(deps: {
  // The work. Resolves to "did anything change"; may reject.
  sweep: () => Promise<boolean>;
  ttlMs: number;
  // Injectable clock so TTL behaviour is testable without waiting.
  now?: () => number;
  onError?: (err: unknown) => void;
}): SweepScheduler {
  const now = deps.now ?? Date.now;
  let lastFinishedAt = 0;
  let inFlight: Promise<boolean> | null = null;

  const start = (): Promise<boolean> => {
    const run = deps
      .sweep()
      .catch((err) => {
        deps.onError?.(err);
        return false;
      })
      .finally(() => {
        // Stamp on FINISH, not on start: throttling from the start time would
        // let a slow sweep be followed immediately by another.
        lastFinishedAt = now();
        // Only clear if we are still the current sweep — a forced sweep may
        // already have replaced us.
        if (inFlight === run) inFlight = null;
      });
    inFlight = run;
    return run;
  };

  const schedule = async (force: boolean): Promise<boolean> => {
    if (force) {
      // Wait the stale sweep out rather than adopting its result, then run.
      if (inFlight) await inFlight.catch(() => false);
      return start();
    }
    if (inFlight) return inFlight;
    if (now() - lastFinishedAt < deps.ttlMs) return false;
    return start();
  };

  return {
    isRunning: () => inFlight !== null,
    run: (opts = {}) => {
      const sweep = schedule(!!opts.force);
      return opts.maxWaitMs === undefined
        ? sweep
        : stopWaiting(sweep, opts.maxWaitMs);
    },
  };
}

// Resolve `false` once the deadline passes, leaving the sweep running. The
// caller stops waiting; the work does not stop.
function stopWaiting(sweep: Promise<boolean>, maxWaitMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), maxWaitMs);
  });
  return Promise.race([sweep, deadline]).finally(() => clearTimeout(timer));
}
