import { proxyListSessionsOrNull } from '../terminalServerClient.js';
import {
  abandonConflictWaiter,
  registerConflictWaiter,
  type RunState,
} from './state.js';

// Why a merge-run worker parked on a conflict waiter needs a liveness backstop:
//
// registerConflictWaiter has no timeout. The graceful releases are /complete,
// /merged, /merge-aborted (all via signalConflictWaiter) and cancelRun. But a
// resolver session can die WITHOUT hitting any of them — a process crash, OOM,
// the user killing the pty directly, or a Stop hook that never fires. Then the
// run worker awaits forever, finalizeMergeRun's releaseLock never runs, the
// cross-process project run-lock stays held, and every later /merge, merge-run,
// and workflow Merge control step returns 409 for that project until a backend
// restart. A workflow-driven run has no manual Cancel escape either.
//
// So instead of awaiting the bare waiter promise, park sites await this: it
// races the waiter against a periodic liveness probe of the resolver pty (via
// the terminal-server session registry) plus an absolute wall-clock backstop.
// If the pty is gone (or the cap elapses) we release the run so it can move on.

export type WaiterReleaseReason = 'signalled' | 'resolver-dead' | 'timeout';

export type WaiterLivenessConfig = {
  // Delay before the FIRST liveness probe. The resolver pty is spawned (and
  // awaited) before we park, but registration with the terminal-server can lag
  // slightly and a queued spawn may not have a session yet — so give it a
  // generous head start before we start counting it as dead.
  graceMs: number;
  // Interval between liveness probes once past the grace period.
  pollMs: number;
  // Consecutive "no live resolver pty" observations required before we declare
  // the resolver dead. A single miss doesn't count: a transient terminal-server
  // blip surfaces as "can't tell" (proxyListSessionsOrNull → null), which
  // resets the counter, and this guards a momentary in-between-spawn gap too.
  deadStrikes: number;
  // Wall-clock cap measured from the last time the probe CONFIRMED the resolver
  // alive (or from the start if it never has) — the ultimate backstop for when
  // the liveness probe stays unreliable (e.g. the terminal-server perpetually
  // answers "can't tell" so strikes never accumulate). Deliberately NOT an
  // absolute cap on total wait: a resolver the probe can positively see alive
  // keeps resetting it and is never wall-clock-killed (liveness is preferred
  // over a pure wall-clock cap). Generous: resolvers can run many minutes.
  maxWaitMs: number;
};

// Production defaults. A dead resolver is detected in roughly
// graceMs + deadStrikes*pollMs (~75s) — fast enough to keep a workflow moving,
// slow enough that a slow-to-register or briefly-restarting resolver isn't
// killed. maxWaitMs is only reached after that long WITHOUT the probe ever
// confirming the resolver alive (i.e. liveness stayed indeterminate).
export const DEFAULT_WAITER_LIVENESS_CONFIG: WaiterLivenessConfig = {
  graceMs: 30_000,
  pollMs: 15_000,
  deadStrikes: 3,
  maxWaitMs: 30 * 60_000,
};

export type WaiterLivenessDeps = {
  // Best-effort session list; null == terminal-server unreachable ("can't
  // tell"), which must never be read as "no sessions" (see proxyListSessionsOrNull).
  listSessions: () => Promise<unknown[] | null>;
  now: () => number;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
};

const productionDeps: WaiterLivenessDeps = {
  listSessions: proxyListSessionsOrNull,
  now: () => Date.now(),
  setTimer: (fn, ms) => {
    const handle = setTimeout(fn, ms);
    // Never let the poll timer alone keep the process alive.
    (handle as { unref?: () => void }).unref?.();
    return handle;
  },
  clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

// Normalize a cwd the same way the terminal-server's killSessionsByCwd does, so
// "is there a live session under this worktree" agrees with "which sessions get
// killed for this worktree".
function normCwd(p: string): string {
  return p.replace(/[\\/]+$/, '').toLowerCase();
}

function cwdWithin(sessionNorm: string, baseNorm: string): boolean {
  return (
    sessionNorm === baseNorm ||
    sessionNorm.startsWith(baseNorm + '/') ||
    sessionNorm.startsWith(baseNorm + '\\')
  );
}

// true  = a live pty exists under the worktree
// false = terminal-server reachable and reports no such pty (resolver is gone)
// null  = can't tell (no worktree path, or terminal-server unreachable)
async function isResolverPtyAlive(
  worktreePath: string | undefined,
  deps: WaiterLivenessDeps,
): Promise<boolean | null> {
  if (!worktreePath) return null;
  const sessions = await deps.listSessions();
  if (sessions === null) return null;
  const base = normCwd(worktreePath);
  for (const s of sessions) {
    const cwd = (s as { cwd?: unknown })?.cwd;
    if (typeof cwd === 'string' && cwdWithin(normCwd(cwd), base)) return true;
  }
  return false;
}

// Register a conflict waiter for `taskId` and await it, but release early if the
// resolver pty dies or the absolute cap elapses. Registration happens
// SYNCHRONOUSLY (this function is intentionally NOT async), so a caller can
// register-then-release-the-merge-lock without a signal racing in between — the
// same ordering guarantee the bare registerConflictWaiter gave.
export function awaitResolverWaiter(
  state: RunState,
  runId: string,
  taskId: string,
  worktreePath: string | undefined,
  config: WaiterLivenessConfig = DEFAULT_WAITER_LIVENESS_CONFIG,
  deps: WaiterLivenessDeps = productionDeps,
  registeredWaiter?: Promise<void>,
): Promise<WaiterReleaseReason> {
  const waiter = registeredWaiter ?? registerConflictWaiter(state, runId, taskId);
  return raceWaiterAgainstLiveness(
    state,
    runId,
    taskId,
    worktreePath,
    waiter,
    config,
    deps,
  );
}

async function raceWaiterAgainstLiveness(
  state: RunState,
  runId: string,
  taskId: string,
  worktreePath: string | undefined,
  waiter: Promise<void>,
  config: WaiterLivenessConfig,
  deps: WaiterLivenessDeps,
): Promise<WaiterReleaseReason> {
  let done = false;
  let reason: WaiterReleaseReason = 'signalled';
  let resolveOuter!: () => void;
  const outer = new Promise<void>((resolve) => {
    resolveOuter = resolve;
  });
  const finish = (r: WaiterReleaseReason): void => {
    if (done) return;
    done = true;
    reason = r;
    resolveOuter();
  };

  // The real completion path.
  void waiter.then(() => finish('signalled'));

  // The liveness/timeout backstop: a self-rescheduling probe (setTimeout rather
  // than setInterval so a slow probe can't overlap itself).
  const startedAt = deps.now();
  // Last time the probe positively confirmed the resolver alive — the wall-clock
  // cap is measured from here (see maxWaitMs), so a confirmed-alive resolver is
  // never killed on a pure timer.
  let lastAliveAt = startedAt;
  let strikes = 0;
  let timer: unknown;
  const tick = async (): Promise<void> => {
    if (done) return;
    if (deps.now() - startedAt >= config.graceMs) {
      const alive = await isResolverPtyAlive(worktreePath, deps);
      if (done) return;
      if (alive === true) {
        strikes = 0;
        lastAliveAt = deps.now();
      } else if (alive === false) {
        strikes += 1;
        if (strikes >= config.deadStrikes) {
          finish('resolver-dead');
          return;
        }
      } else {
        // can't-tell: neither confirms alive nor counts as a death strike.
        strikes = 0;
      }
    }
    // Wall-clock backstop, from the last confirmed-alive probe (or start). Only
    // bites when liveness has stayed unconfirmable long enough — a resolver we
    // can see alive keeps resetting lastAliveAt and is never timed out here.
    if (!done && deps.now() - lastAliveAt >= config.maxWaitMs) {
      finish('timeout');
      return;
    }
    if (!done) timer = deps.setTimer(() => void tick(), config.pollMs);
  };
  timer = deps.setTimer(() => void tick(), config.pollMs);

  try {
    await outer;
  } finally {
    if (timer !== undefined) deps.clearTimer(timer);
    // If the liveness backstop won the race the waiter is still registered and
    // pending — drop it so it can't leak or be found by a stray late callback.
    // (A real 'signalled' already deleted the entry.)
    if (reason !== 'signalled') abandonConflictWaiter(state, taskId, runId);
  }
  return reason;
}
