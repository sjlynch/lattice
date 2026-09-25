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

import {
  cleanupPushSession,
  getPushRun,
  markPushRunLost,
  pushRunStore,
  restorePushRun,
  type PushRun,
} from '../pushRuns.js';
import { pushAgentId } from '../pushRuns/stopHook.js';
import {
  applyRecordedQaVerdict,
  cleanupQaSession,
  getQaRun,
  markQaRunDone,
  qaAgentId,
  qaRunStore,
  restoreQaRun,
  type QaRun,
} from '../qaRuns.js';
import {
  endPostMergeHook,
  getPostMergeHook,
  POST_MERGE_HOOK_MAX_WAIT_MS,
  postMergeHookStore,
  restorePostMergeHook,
  waitForPostMergeHook,
  type PostMergeHookRun,
} from '../postMergeHooks.js';
import { postMergeHookAgentId } from '../postMergeHooks/stopHook.js';
import { registerAgentSession, unregisterAgentSession } from '../agentSessions.js';
import { markAgentReadopted } from '../agentQuiescence.js';
import {
  postMergeHookStopFinish,
  requestPostMergeHookStopComplete,
} from '../postMergeHooks/stopHookGate.js';
import { proxyListSessionsOrNull } from '../terminalServerClient.js';
import { findStepSessionId, type ProbedSession } from '../workflowRuns/resumeDecision.js';
import { forEachKnownProjectSafely } from './projectIteration.js';

// A pty found gone is settled only after this long, giving the callback outbox
// time to replay a completion the agent sent while the backend was down.
export const LOST_SETTLE_GRACE_MS = 90_000;
// How often the liveness watch re-probes the re-adopted runs' ptys.
export const ONE_OFF_WATCH_INTERVAL_MS = 30_000;
// A re-adopted post-merge hook gets at least this long to call back, even when
// it had already used up the merge's 30-minute budget before the restart.
export const READOPTED_HOOK_MIN_WAIT_MS = 5 * 60 * 1000;

export type OneOffRunKind = 'push' | 'qa' | 'post-merge-hook';

// Pure policy, kept separate so it is testable without IO. `alive` is
// true (pty found at the run's scratch cwd), false (definitively gone) or null
// (the terminal-server could not be probed).
export function classifyOneOffRunResume(alive: boolean | null): 'readopt' | 'settle-when-lost' {
  return alive === false ? 'settle-when-lost' : 'readopt';
}

type AnyRun = { id: string; projectPath: string; cwd: string };

type Adapter<Run extends AnyRun> = {
  kind: OneOffRunKind;
  noun: string;
  load(projectPath: string): Promise<Run[]>;
  // `alive: false` = the pty is already known gone (settled after the grace).
  restore(run: Run, alive: boolean): boolean;
  isRunning(id: string): boolean;
  // Presence / quiescence / wait bookkeeping for a session believed alive.
  onReadopted(run: Run): void;
  // Settle a run whose pty is gone, and reclaim its scratch dir (usually a
  // no-op: the boot sweep already took a dir whose pty died before boot).
  settleLost(run: Run, reason: string): Promise<void>;
};

const pushAdapter: Adapter<PushRun> = {
  kind: 'push',
  noun: 'push run',
  load: (p) => pushRunStore.load(p),
  // A push whose pty is gone is flagged `lost` up front so a re-dispatched
  // workflow Push step spawns a fresh push instead of attaching to it.
  restore: (run, alive) => restorePushRun(alive ? run : { ...run, lost: true }),
  isRunning: (id) => getPushRun(id)?.status === 'running',
  onReadopted: (run) =>
    registerAgentSession({ agentId: pushAgentId(run.id), projectPath: run.projectPath, label: 'push' }),
  settleLost: async (run) => {
    unregisterAgentSession(pushAgentId(run.id));
    markPushRunLost(run.id);
    await cleanupPushSession(run.projectPath, run.id);
  },
};

const qaAdapter: Adapter<QaRun> = {
  kind: 'qa',
  noun: 'QA run',
  load: (p) => qaRunStore.load(p),
  restore: (run) => restoreQaRun(run),
  isRunning: (id) => getQaRun(id)?.status === 'running',
  onReadopted: (run) =>
    registerAgentSession({ agentId: qaAgentId(run.id), projectPath: run.projectPath, label: 'qa' }),
  settleLost: async (run) => {
    unregisterAgentSession(qaAgentId(run.id));
    // What `/done` would have done: apply whatever verdict the agent reported
    // before its terminal went away (a confident PASS still promotes the
    // task), then close the run. No verdict ⇒ the task stays in QA.
    try {
      await applyRecordedQaVerdict(run.id);
    } catch (err) {
      console.warn(`[startup] QA run ${run.id}: applying its recorded verdict failed:`, err);
    }
    markQaRunDone(run.id);
    await cleanupQaSession(run.projectPath, run.id);
  },
};

const postMergeHookAdapter: Adapter<PostMergeHookRun> = {
  kind: 'post-merge-hook',
  noun: 'post-merge hook',
  load: (p) => postMergeHookStore.load(p),
  restore: (run) => restorePostMergeHook(run),
  isRunning: (id) => getPostMergeHook(id)?.status === 'running',
  onReadopted: (run) => {
    const agentId = postMergeHookAgentId(run.id);
    // Graph presence for any harness (each reports activity through its own
    // hooks); the quiescence re-adoption below only matters to Claude, whose
    // Stop hook is the one gated on it.
    registerAgentSession({ agentId, projectPath: run.projectPath, label: 'post-merge hook' });
    if (run.harness === 'claude') {
      // Its live-subagent state died with the old process: a premature Stop
      // must not finish the hook while a pre-restart subagent still works.
      // A Stop the old process was already holding starts the quiet window
      // from that Stop rather than from this boot.
      markAgentReadopted(
        agentId,
        run.stopReceivedAt !== undefined
          ? { stopAt: run.stopReceivedAt, activeAt: run.stopActiveAt, busy: run.stopBusy }
          : undefined,
      );
    }
    // The previous process had received this hook's Stop and was only waiting
    // out the quiescence gate. The hook got its 200 and the agent is idle —
    // no second Stop is coming, so re-arm the gate or the hook just sits
    // "running" until its bounded wait errors it.
    if (run.stopReceivedAt !== undefined) {
      requestPostMergeHookStopComplete(run.id, postMergeHookStopFinish(run.id, run.projectPath), undefined, {
        rearm: true,
      });
    }
    armReadoptedHookWait(run);
  },
  settleLost: async (run, reason) => {
    // Also reclaims the scratch dir (a no-op after the boot sweep took it).
    await endPostMergeHook(run.id, 'errored', `post-merge hook ${reason}`, { killSession: false });
  },
};

// The merge that fired this hook waited on it with a bounded wait
// (`POST_MERGE_HOOK_MAX_WAIT_MS` from its start). That waiter died with the old
// process; re-arm the remainder so a re-adopted hook whose agent hangs is
// still ended rather than blocking the project's next hook (and Phase C)
// forever. A resumed merge run that awaits it adds its own bounded wait too.
function armReadoptedHookWait(run: PostMergeHookRun): void {
  const elapsed = Math.max(0, Date.now() - run.startedAt);
  const remaining = Math.max(READOPTED_HOOK_MIN_WAIT_MS, POST_MERGE_HOOK_MAX_WAIT_MS - elapsed);
  void waitForPostMergeHook(run.id, remaining)
    .then(async (result) => {
      if (result === 'expired') {
        await endPostMergeHook(run.id, 'errored', 'timed out', { killSession: true });
      }
    })
    .catch((err) => console.warn(`[post-merge-hook] ${run.id}: re-adopted wait failed:`, err));
}

// ---------------------------------------------------------------------------
// Liveness watch
// ---------------------------------------------------------------------------

type Watched = {
  adapter: Adapter<AnyRun>;
  run: AnyRun;
  // When the pty was first seen gone (cleared if it is seen again).
  goneSince?: number;
  reason: string;
};

const watched = new Map<string, Watched>();
let watchTimer: ReturnType<typeof setInterval> | null = null;
let ticking = false;

export type OneOffResumeDeps = {
  listSessions?: () => Promise<unknown[] | null>;
  forEachProject?: typeof forEachKnownProjectSafely;
  now?: () => number;
  // Tests drive the watch by hand.
  startWatch?: boolean;
};

function watchKey(kind: OneOffRunKind, id: string): string {
  return `${kind}:${id}`;
}

function sessionAlive(sessions: readonly ProbedSession[], run: AnyRun): boolean {
  return findStepSessionId(sessions, run.cwd) !== null;
}

function ensureWatch(): void {
  if (watchTimer || watched.size === 0) return;
  watchTimer = setInterval(() => void runOneOffRunWatchTick(), ONE_OFF_WATCH_INTERVAL_MS);
  watchTimer.unref?.();
}

function stopWatchIfIdle(): void {
  if (watched.size > 0 || !watchTimer) return;
  clearInterval(watchTimer);
  watchTimer = null;
}

// One pass of the liveness watch. Exported for tests.
export async function runOneOffRunWatchTick(deps: OneOffResumeDeps = {}): Promise<void> {
  if (ticking) return;
  if (watched.size === 0) {
    stopWatchIfIdle();
    return;
  }
  ticking = true;
  try {
    const sessions = (await (deps.listSessions ?? proxyListSessionsOrNull)()) as ProbedSession[] | null;
    // Can't tell ≠ gone: never settle on an unreachable terminal-server.
    if (sessions === null) return;
    const now = (deps.now ?? Date.now)();
    for (const [key, entry] of [...watched]) {
      if (!entry.adapter.isRunning(entry.run.id)) {
        // Its own callback (or a replay from the outbox) settled it.
        watched.delete(key);
        continue;
      }
      if (sessionAlive(sessions, entry.run)) {
        entry.goneSince = undefined;
        continue;
      }
      if (entry.goneSince === undefined) {
        entry.goneSince = now;
        entry.reason = 'terminal exited without calling back';
      }
      if (now - entry.goneSince < LOST_SETTLE_GRACE_MS) continue;
      watched.delete(key);
      console.warn(
        `[startup] ${entry.adapter.noun} ${entry.run.id} (${entry.run.projectPath}): ${entry.reason} — settling it as lost.`,
      );
      await entry.adapter
        .settleLost(entry.run, entry.reason)
        .catch((err) => console.warn(`[startup] ${entry.adapter.noun} ${entry.run.id}: settle failed:`, err));
    }
  } finally {
    ticking = false;
    stopWatchIfIdle();
  }
}

// Test seam: forget every watched run and stop the timer.
export function resetOneOffRunWatch(): void {
  watched.clear();
  if (watchTimer) clearInterval(watchTimer);
  watchTimer = null;
}

export function watchedOneOffRunIds(): string[] {
  return [...watched.keys()];
}

// ---------------------------------------------------------------------------
// Boot entry point
// ---------------------------------------------------------------------------

export async function resumeInterruptedOneOffRuns(deps: OneOffResumeDeps = {}): Promise<void> {
  // One terminal-server probe for the whole sweep; null = "couldn't ask".
  const sessions = (await (deps.listSessions ?? proxyListSessionsOrNull)()) as ProbedSession[] | null;
  const now = (deps.now ?? Date.now)();
  const forEachProject = deps.forEachProject ?? forEachKnownProjectSafely;
  const adapters = [pushAdapter, qaAdapter, postMergeHookAdapter] as unknown as Adapter<AnyRun>[];

  await forEachProject('resumeInterruptedOneOffRuns', async (repoRoot) => {
    for (const adapter of adapters) {
      const persisted = await adapter.load(repoRoot);
      for (const run of persisted) {
        const serverId = sessions ? findStepSessionId(sessions, run.cwd) : null;
        const decision = classifyOneOffRunResume(sessions === null ? null : serverId !== null);
        // Point the record at the pty actually found at its cwd (the tab-close
        // path looks a post-merge hook up by it).
        const restored = serverId ? { ...run, serverId } : run;
        if (!adapter.restore(restored, decision === 'readopt')) continue;
        const entry: Watched = { adapter, run: restored, reason: 'terminal did not survive a backend restart' };
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
        watched.set(watchKey(adapter.kind, run.id), entry);
      }
    }
  });
  if (deps.startWatch !== false) ensureWatch();
}
