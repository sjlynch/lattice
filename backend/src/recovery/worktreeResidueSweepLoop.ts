// Periodic + on-demand passes of the worktree residue sweep
// (`worktreeResidueSweep.ts`). The boot pass rides on `sweepOrphanedWorktrees`;
// these catch residue that appears while the backend is up — a finalize or
// task-delete cleanup whose `git worktree remove` failed on a locked file — so
// it no longer waits for the next restart. Also triggered from the disk-wait
// path (`diskPressureMerge.ts`): on a big repo that residue is what the
// waiting runs are waiting on.
//
// Single-flight: a request while a pass runs joins it. The per-project guard
// inside `sweepWorktreeResidue` also keeps a pass off a project the boot pass
// is still sweeping.

import { listTasks } from '../tasks.js';
import { gitDirExists } from '../worktree/state.js';
import { projectGit } from '../worktree/projectGit.js';
import { forEachKnownProjectSafely } from './projectIteration.js';
import { collectLiveSessionCwds } from './liveSessions.js';
import { sweepWorktreeResidue } from './worktreeResidueSweep.js';

export const WORKTREE_RESIDUE_SWEEP_INTERVAL_MS = 30 * 60_000;
// A disk-waiting run re-requests a pass on every retry of its backoff; one
// pass per this window is plenty (fresh residue is under the 10-min age gate
// anyway, and locked dirs are on their own backoff).
const REQUEST_MIN_GAP_MS = 2 * 60_000;
const LOG_PREFIX = '[residue-sweep]';

export type ResidueSweepPassDeps = {
  forEachKnownProjectSafely: typeof forEachKnownProjectSafely;
  gitDirExists: typeof gitDirExists;
  listTasks: typeof listTasks;
  projectGit: typeof projectGit;
  collectLiveSessionCwds: typeof collectLiveSessionCwds;
  sweepResidue: typeof sweepWorktreeResidue;
};

const defaultDeps: ResidueSweepPassDeps = {
  forEachKnownProjectSafely, gitDirExists, listTasks, projectGit,
  collectLiveSessionCwds, sweepResidue: sweepWorktreeResidue,
};

let timer: NodeJS.Timeout | null = null;
let passInFlight: Promise<void> | null = null;
let lastPassStartedAt = -Infinity;
let unreachableLogged = false;

async function runPass(deps: ResidueSweepPassDeps): Promise<void> {
  // Detached PTYs survive a backend restart; without an authoritative session
  // inventory the live-pty check can't be trusted, so skip the whole pass.
  const liveCwds = await deps.collectLiveSessionCwds();
  if (liveCwds === null) {
    if (!unreachableLogged) {
      console.warn(`${LOG_PREFIX} terminal-server unreachable — skipping residue passes until it is back`);
      unreachableLogged = true;
    }
    return;
  }
  unreachableLogged = false;
  await deps.forEachKnownProjectSafely('worktreeResidueSweep', async (repoRoot) => {
    try {
      if (!(await deps.gitDirExists(repoRoot))) return; // project moved/deleted
      const tasks = await deps.listTasks(repoRoot);
      // Same guard as the boot sweep: zero records may be a corrupt task DB,
      // and task ownership is one of the conditions.
      if (tasks.length === 0) return;
      await deps.sweepResidue(repoRoot, tasks, liveCwds, deps.projectGit, undefined, { logPrefix: LOG_PREFIX });
    } catch (err) {
      console.warn(`${LOG_PREFIX} ${repoRoot} failed:`, err);
    }
  });
}

// Run a pass now, or join the one already running. Never rejects.
export function runWorktreeResidueSweepPass(deps: ResidueSweepPassDeps = defaultDeps): Promise<void> {
  if (passInFlight) return passInFlight;
  lastPassStartedAt = Date.now();
  passInFlight = runPass(deps)
    .catch((err) => console.warn(`${LOG_PREFIX} pass failed:`, err))
    .finally(() => { passInFlight = null; });
  return passInFlight;
}

// Fire-and-forget request (the disk-wait path). Coalesced: ignored while a pass
// runs or within REQUEST_MIN_GAP_MS of the last one starting.
export function requestWorktreeResidueSweep(deps: ResidueSweepPassDeps = defaultDeps): boolean {
  if (passInFlight || Date.now() - lastPassStartedAt < REQUEST_MIN_GAP_MS) return false;
  void runWorktreeResidueSweepPass(deps);
  return true;
}

export function startWorktreeResidueSweepLoop(
  intervalMs: number = WORKTREE_RESIDUE_SWEEP_INTERVAL_MS,
): void {
  if (timer) return;
  // First periodic pass after one full interval — boot already ran one.
  timer = setInterval(() => { void runWorktreeResidueSweepPass(); }, intervalMs);
  // Don't keep the event loop alive — the HTTP server already does that.
  if (typeof timer.unref === 'function') timer.unref();
}

export function stopWorktreeResidueSweepLoop(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

// Test seam.
export function resetWorktreeResidueSweepLoopForTests(): void {
  stopWorktreeResidueSweepLoop();
  passInFlight = null;
  lastPassStartedAt = -Infinity;
  unreachableLogged = false;
}
