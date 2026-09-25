// The restart-drain gate: a short-lived "a restart is about to happen, don't
// start anything new" mode, entered at the dev runner's request right before it
// kills this process (see ./CLAUDE.md and backend/scripts/dev/restartHandshake.mjs).
//
// Leaf module on purpose — no imports. The spawn queue, the project run lock
// and the pty-create chokepoint all consult it, and it must never drag the
// workflow / merge engines into their import graphs.
//
// Two halves:
//   - the DRAIN itself: `beginRestartDrain` / `endRestartDrain` /
//     `isRestartDraining` / `waitWhileRestartDraining`. It always carries a
//     TTL: the dev runner that asked for it may crash, decide not to restart
//     after all (a compile started, a run.lock appeared), or never come back,
//     and a drain that outlived its restart would silently freeze every spawn
//     and every merge on this backend. Expiry (or an explicit end) wakes every
//     waiter and every `onRestartDrainEnded` listener, so held work proceeds.
//   - the TRANSITION TRACKER: `beginRestartTransition` / `trackRestartTransition`
//     mark a short multi-step state change that a kill must not land in the
//     middle of (a workflow step advance, a control step's lock hand-off, a
//     pty create). `settle.ts` waits for the set to empty before reporting the
//     backend ready. It is independent of the drain — tracking is always on.

export const RESTART_DRAIN_DEFAULT_TTL_MS = 90_000;
// A caller can ask for longer, never for "forever".
export const RESTART_DRAIN_MAX_TTL_MS = 5 * 60_000;
export const RESTART_DRAIN_MIN_TTL_MS = 1_000;

type DrainState = {
  until: number;
  reason: string;
  startedAt: number;
  timer: ReturnType<typeof setTimeout>;
};

let drain: DrainState | null = null;
const waiters = new Set<() => void>();
const endListeners = new Set<(why: string) => void>();

export function clampRestartDrainTtl(ttlMs: unknown): number {
  const n = typeof ttlMs === 'number' && Number.isFinite(ttlMs) ? ttlMs : RESTART_DRAIN_DEFAULT_TTL_MS;
  return Math.min(RESTART_DRAIN_MAX_TTL_MS, Math.max(RESTART_DRAIN_MIN_TTL_MS, Math.round(n)));
}

export function isRestartDraining(now: number = Date.now()): boolean {
  return drain !== null && now < drain.until;
}

export type RestartDrainSnapshot = {
  draining: boolean;
  until: number | null;
  reason: string | null;
  startedAt: number | null;
};

export function getRestartDrainState(now: number = Date.now()): RestartDrainSnapshot {
  if (!drain || now >= drain.until) return { draining: false, until: null, reason: null, startedAt: null };
  return { draining: true, until: drain.until, reason: drain.reason, startedAt: drain.startedAt };
}

// Enter (or extend) the drain. Idempotent: a repeated prepare from the same
// dev runner just pushes the expiry out; it never shortens it.
export function beginRestartDrain(
  reason: string,
  ttlMs: number = RESTART_DRAIN_DEFAULT_TTL_MS,
  now: number = Date.now(),
): RestartDrainSnapshot {
  const until = now + clampRestartDrainTtl(ttlMs);
  if (drain) {
    if (until > drain.until) {
      clearTimeout(drain.timer);
      drain.until = until;
      drain.timer = armExpiry(until - now);
    }
    drain.reason = reason || drain.reason;
  } else {
    drain = { until, reason, startedAt: now, timer: armExpiry(until - now) };
    console.log(
      `[restart-drain] draining for a backend restart (${reason || 'no reason given'}) — ` +
        `new spawns / run-lock acquisitions / workflow + merge starts are held for up to ` +
        `${Math.round((until - now) / 1000)} s`,
    );
  }
  return getRestartDrainState(now);
}

function armExpiry(ms: number): ReturnType<typeof setTimeout> {
  const timer = setTimeout(() => {
    // No restart followed. Whatever asked for the drain is gone or changed its
    // mind without saying so — resume normal service rather than stay frozen.
    endRestartDrain('ttl expired without a restart');
  }, ms);
  timer.unref?.();
  return timer;
}

// Leave the drain (explicit cancel from the dev runner, or TTL expiry). Wakes
// every waiter and listener. Returns false when no drain was active.
export function endRestartDrain(why: string): boolean {
  if (!drain) return false;
  clearTimeout(drain.timer);
  const heldFor = Date.now() - drain.startedAt;
  drain = null;
  console.log(`[restart-drain] drain ended after ${Math.round(heldFor / 100) / 10} s (${why}) — resuming normal service`);
  for (const wake of [...waiters]) wake();
  waiters.clear();
  for (const fn of [...endListeners]) {
    try {
      fn(why);
    } catch (err) {
      console.error('[restart-drain] drain-ended listener threw (isolated):', err);
    }
  }
  return true;
}

// Called when the drain ends — the spawn queue re-drains its held requests.
export function onRestartDrainEnded(fn: (why: string) => void): () => void {
  endListeners.add(fn);
  return () => { endListeners.delete(fn); };
}

// Resolve once no drain is active. A drain always ends (TTL), so this is a
// bounded wait; if the restart it was for happens first, the process is gone
// and the caller's durable state (a queued run, a `pending` workflow step, the
// frontend's retry) is what carries the work across.
export function waitWhileRestartDraining(): Promise<void> {
  if (!isRestartDraining()) return Promise.resolve();
  return new Promise<void>((resolve) => {
    waiters.add(resolve);
  });
}

// ---------------------------------------------------------------------------
// Transition tracker
// ---------------------------------------------------------------------------

let nextTransitionId = 1;
const transitions = new Map<number, { label: string; since: number }>();

// Mark the start of a transition; call the returned function (exactly once is
// enough — extra calls are no-ops) when it has settled.
export function beginRestartTransition(label: string): () => void {
  const id = nextTransitionId++;
  transitions.set(id, { label, since: Date.now() });
  return () => { transitions.delete(id); };
}

export function trackRestartTransition<T>(label: string, work: Promise<T>): Promise<T> {
  const end = beginRestartTransition(label);
  work.then(end, end);
  return work;
}

// Labels of the transitions still in flight, oldest first, with their age.
export function pendingRestartTransitions(now: number = Date.now()): string[] {
  return [...transitions.values()]
    .sort((a, b) => a.since - b.since)
    .map((t) => `${t.label} (${Math.round((now - t.since) / 100) / 10} s)`);
}

// Test seam: forget all drain + transition state. Module-level listeners (the
// spawn queue's re-drain) stay registered.
export function resetRestartDrainForTests(): void {
  if (drain) clearTimeout(drain.timer);
  drain = null;
  for (const wake of [...waiters]) wake();
  waiters.clear();
  transitions.clear();
}
