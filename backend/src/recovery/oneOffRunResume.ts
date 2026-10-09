// Boot step 3a: re-adopt one-off agent runs (push runs, QA e2e runs,
// post-merge hooks) whose pty survived a backend restart in the detached
// terminal-server — sibling of `workflowRunResume.ts`. Invariants + module map:
// recovery/oneOffRunResume/CLAUDE.md.
//
// Reads the `{push-runs,qa-runs,post-merge-hooks}.json` mirrors BEFORE the HTTP
// server listens, so the first callback (or outbox replay) finds its record — an
// unknown id 404s and the agent's terminal idles forever. Per record:
//   - pty alive, or the terminal-server can't be probed ("can't tell" is never
//     "gone") → RE-ADOPT: restore the record + presence node; a post-merge hook
//     also regains its one-running-per-project state (a resumed merge run /
//     Phase C await it, never start a second), `markAgentReadopted`
//     (agentQuiescence.ts) and the bounded wait a merge would have given it.
//   - pty gone → restore, then settle LOST after `LOST_SETTLE_GRACE_MS` unless
//     its callback lands first (the outbox replays a Stop fired while the backend
//     was down). Lost = push `lost` + done (a waiting Push step fails); QA done
//     with any reported verdict still applied; hook finished `errored`.
// Re-adopted records join a liveness watch that settles a pty dying later
// without a callback the same way. Runs before the boot scratch sweeps, which
// keep only live-pty dirs.

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
