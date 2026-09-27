// Boot-time re-adoption of one-off agent runs (push runs, QA e2e runs,
// post-merge hooks) interrupted by a backend restart.
//
// Sibling of `workflowRunResume.ts`, for the same reason: each of these runs a
// throwaway agent whose pty lives in the DETACHED terminal-server and survives
// a backend restart, while its run record lived only in this process's memory.
// After a restart the agent's callback (`/api/push-runs/:id/done`,
// `/api/qa-runs/:id/verdict` + `/done`, `/api/post-merge-hooks/:id/complete`)
// hit an unknown id and 404'd, its terminal idled forever, a QA pass never
// promoted its task, and a resumed merge run could not see the still-running
// post-merge hook — so it fired a second one, or the workflow Merge step's
// Phase C read "idle" while the orphan kept working.
//
// The registries now mirror their running records to
// `~/.lattice/per-project/<hash>/{push-runs,qa-runs,post-merge-hooks}.json`
// (`../homeScratch/persistence.ts`). This reads them BEFORE the HTTP server
// listens — so the first callback (or a replay from the callback outbox) finds
// its record — and per record:
//
//   pty alive (or the terminal-server can't be probed — "can't tell" is never
//   "gone") → RE-ADOPT: restore the record, re-register its orange presence
//     node, and for a post-merge hook restore the one-running-per-project
//     state (so the resumed merge run / Phase C / the UI await it rather than
//     start a second), mark its quiescence state unknown (see
//     `agentQuiescence.ts` `markAgentReadopted`) and re-arm the bounded wait a
//     merge would have given it.
//   pty gone → restore it anyway and settle it as LOST after
//     `LOST_SETTLE_GRACE_MS`, unless its callback lands first. A Stop hook
//     that fired while the backend was down is replayed by the callback
//     outbox shortly after listen; settling immediately would record "lost"
//     for a run that actually finished. Lost = push: done + `lost` (a waiting
//     workflow Push step fails instead of reporting success); QA: done, with
//     any verdict it had already reported still applied (a confident PASS
//     still promotes qa → done); post-merge hook: finished `errored`, which
//     releases its waiters. The scratch dir itself is reclaimed by the boot
//     sweeps that run right after this (they keep only live-pty dirs).
//
// Every re-adopted record also joins a small liveness watch: a pty that dies
// later without calling back is settled the same way (the pre-restart process
// had its own waiters — the merge gate's bounded wait, the Push step's timeout
// — and this is the restarted process's equivalent).

import { pushAdapter, qaAdapter, postMergeHookAdapter } from './oneOffRunResume/adapters.js';
import { proxyListSessionsOrNull } from '../terminalServerClient.js';
import { findStepSessionId, type ProbedSession } from '../workflowRuns/resumeDecision.js';
import { forEachKnownProjectSafely } from './projectIteration.js';
import {
  LOST_SETTLE_GRACE_MS,
  type Adapter,
  type AnyRun,
  type OneOffResumeDeps,
  type Watched,
} from './oneOffRunResume/contracts.js';
import { ensureWatch, watchOneOffRun } from './oneOffRunResume/watch.js';

export {
  LOST_SETTLE_GRACE_MS,
  ONE_OFF_WATCH_INTERVAL_MS,
  READOPTED_HOOK_MIN_WAIT_MS,
  type OneOffResumeDeps,
  type OneOffRunKind,
} from './oneOffRunResume/contracts.js';
export {
  resetOneOffRunWatch,
  runOneOffRunWatchTick,
  watchedOneOffRunIds,
} from './oneOffRunResume/watch.js';

// Pure policy, kept separate so it is testable without IO. `alive` is
// true (pty found at the run's scratch cwd), false (definitively gone) or null
// (the terminal-server could not be probed).
export function classifyOneOffRunResume(alive: boolean | null): 'readopt' | 'settle-when-lost' {
  return alive === false ? 'settle-when-lost' : 'readopt';
}

async function resumeAdapterRuns<Run extends AnyRun>(
  adapter: Adapter<Run>,
  repoRoot: string,
  sessions: ProbedSession[] | null,
  now: number,
): Promise<void> {
  const persisted = await adapter.load(repoRoot);
  for (const run of persisted) {
    const serverId = sessions ? findStepSessionId(sessions, run.cwd) : null;
    const decision = classifyOneOffRunResume(sessions === null ? null : serverId !== null);
    // Point the record at the pty actually found at its cwd (the tab-close
    // path looks a post-merge hook up by it).
    const restored = serverId ? { ...run, serverId } : run;
    if (!adapter.restore(restored, decision === 'readopt')) continue;
    const entry: Watched = {
      kind: adapter.kind,
      noun: adapter.noun,
      run: restored,
      isRunning: () => adapter.isRunning(restored.id),
      settleLost: (reason) => adapter.settleLost(restored, reason),
      reason: 'terminal did not survive a backend restart',
    };
    if (decision === 'readopt') {
      adapter.onReadopted(restored);
      console.log(
        `[startup] ${adapter.noun} ${run.id} re-adopted for ${repoRoot} — ` +
          (sessions === null ? 'terminal-server could not be probed, assuming it is still running' : 'its terminal is still alive'),
      );
    } else {
      entry.goneSince = now;
      console.warn(
        `[startup] ${adapter.noun} ${run.id} for ${repoRoot}: its terminal did not survive the restart — ` +
          `settling it as lost in ${Math.round(LOST_SETTLE_GRACE_MS / 1000)}s unless its callback is replayed first.`,
      );
    }
    watchOneOffRun(entry);
  }
}

// ---------------------------------------------------------------------------
// Boot entry point
// ---------------------------------------------------------------------------

export async function resumeInterruptedOneOffRuns(deps: OneOffResumeDeps = {}): Promise<void> {
  // One terminal-server probe for the whole sweep; null = "couldn't ask".
  const sessions = (await (deps.listSessions ?? proxyListSessionsOrNull)()) as ProbedSession[] | null;
  const now = (deps.now ?? Date.now)();
  const forEachProject = deps.forEachProject ?? forEachKnownProjectSafely;

  await forEachProject('resumeInterruptedOneOffRuns', async (repoRoot) => {
    await resumeAdapterRuns(pushAdapter, repoRoot, sessions, now);
    await resumeAdapterRuns(qaAdapter, repoRoot, sessions, now);
    await resumeAdapterRuns(postMergeHookAdapter, repoRoot, sessions, now);
  });
  if (deps.startWatch !== false) ensureWatch();
}
