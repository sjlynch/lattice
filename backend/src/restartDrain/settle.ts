// "Is it safe to kill this process now?" — the second half of the restart
// handshake. With the drain on (gate.ts) nothing NEW starts; this waits for
// what was already in flight to land, then forces every debounced write to
// disk, because the dev runner's kill is TerminateProcess on Windows and runs
// no exit handler at all.
//
// In flight means:
//   - a tracked transition (gate.ts): a workflow start / step advance, a
//     control step's lock hand-off, a pty create;
//   - a spawn-queue thunk already admitted (worktree setup + pty create). The
//     queue admits nothing while draining, so this count only falls.
//
// Bounded: after `budgetMs` it reports `ready: false` with what is still
// pending and the dev runner restarts anyway (fail open) — every one of those
// has a boot-recovery path; the drain only makes hitting it rarer.

import { getSpawnQueueSnapshot } from '../spawnQueue.js';
import { flushWorkflowRunPersist } from '../workflowRuns/persistence.js';
import { flushAllProjectStatePersists } from '../projectStateManager.js';
import { pendingRestartTransitions } from './gate.js';

export const RESTART_SETTLE_DEFAULT_BUDGET_MS = 45_000;
export const RESTART_SETTLE_MAX_BUDGET_MS = 120_000;
export const RESTART_SETTLE_POLL_MS = 100;
// Consecutive quiet polls required: a transition can end and its successor
// begin across one microtask boundary (an advance dispatching a spawn), so
// one quiet sample is not proof of quiet.
export const RESTART_SETTLE_QUIET_POLLS = 3;
// A single flush pass must not wedge the handshake on a stuck disk.
export const RESTART_FLUSH_TIMEOUT_MS = 10_000;

export type RestartSettleDeps = {
  pending: () => string[];
  flush: () => Promise<void>;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
};

function inFlightSpawns(): string[] {
  const n = getSpawnQueueSnapshot().inFlight;
  return n > 0 ? [`${n} admitted spawn(s) still starting`] : [];
}

async function flushEverything(): Promise<void> {
  await Promise.all([
    flushWorkflowRunPersist().catch((err) => console.error('[restart-drain] workflow-run flush failed:', err)),
    flushAllProjectStatePersists().catch((err) => console.error('[restart-drain] state flush failed:', err)),
  ]);
}

const productionDeps: RestartSettleDeps = {
  pending: () => [...pendingRestartTransitions(), ...inFlightSpawns()],
  flush: flushEverything,
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => { setTimeout(resolve, ms).unref?.(); }),
};

export type RestartSettleResult = {
  ready: boolean;
  pending: string[];
  waitedMs: number;
  flushed: boolean;
};

export async function settleForRestart(
  budgetMs: number = RESTART_SETTLE_DEFAULT_BUDGET_MS,
  deps: RestartSettleDeps = productionDeps,
): Promise<RestartSettleResult> {
  const started = deps.now();
  const budget = Math.min(RESTART_SETTLE_MAX_BUDGET_MS, Math.max(0, budgetMs));
  let quiet = 0;
  let pending = deps.pending();
  for (;;) {
    quiet = pending.length === 0 ? quiet + 1 : 0;
    if (quiet >= RESTART_SETTLE_QUIET_POLLS) break;
    if (deps.now() - started >= budget) break;
    await deps.sleep(RESTART_SETTLE_POLL_MS);
    pending = deps.pending();
  }
  // Flush even when not settled: a fail-open restart still shouldn't lose a
  // write that merely sat in a debounce timer.
  let flushed = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    flushed = await Promise.race([
      deps.flush().then(() => true, () => false),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), RESTART_FLUSH_TIMEOUT_MS);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
  // Re-sample after the flush: a transition may have started while writing.
  pending = deps.pending();
  return { ready: pending.length === 0 && flushed, pending, waitedMs: deps.now() - started, flushed };
}
