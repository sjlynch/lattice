// Quiescence gate for the Claude Stop-hook post-merge-hook completion callback
// (the post-merge analogue of `workflowRuns/stopHookGate.ts`).
//
// A post-merge hook is an arbitrary full agent task that may use subagents, and
// then Claude's `Stop` hook fires early and repeatedly (`agentQuiescence.ts`).
// Finishing on a premature Stop resolves the merge run's `waitForPostMergeHook`,
// lets a workflow Merge step's Phase C advance, and lets the frontend queue
// dispatch the next workflow on top of the still-working post-merge agent.
//
// So the Stop-hook-sourced completion doesn't finish on the Stop itself: it waits
// until the session is QUIESCENT — no subagents in flight and no signal of any
// kind (tool use, subagent start/stop, a later Stop) for a short settle window.
// The real Stop always arrives last and premature Stops are followed by more
// activity, so the quiet window lands on the genuine end. Deliberate end-of-work
// signals keep finishing immediately: the model's explicit curl
// (`source=model-explicit-curl`), Pi's `session_shutdown` extension and Codex's
// `Stop` hook. The agent-activity route feeds `agentQuiescence.ts` from the same
// hooks that drive the graph (extended to the `pmh:` agent id).

import { finishPostMergeHook, getPostMergeHook, patchPostMergeHook } from './registry.js';
import { postMergeHookAgentId } from './stopHook.js';
import { cleanupPostMergeHookSession } from './cleanup.js';
import {
  agentHeldActivity,
  forgetAgentQuiescence,
  isAgentQuiescent,
  noteAgentStop,
} from '../agentQuiescence.js';
import { unregisterAgentSession } from '../agentSessions.js';

// Finish only after the session has been fully quiet (no subagents live, no
// signal) for this long. Long enough to bridge the gap between a premature Stop
// and the real one, short enough to add only a small tail to the hook's runtime.
export const PMH_STOP_HOOK_SETTLE_MS = 4000;
// How often to re-check quiescence while waiting.
export const PMH_STOP_HOOK_POLL_MS = 1000;

type GateTiming = { settleMs: number; pollMs: number };

const pending = new Map<string, ReturnType<typeof setTimeout>>();

function clearGate(id: string): void {
  heldActivityPersistedAt.delete(id);
  const timer = pending.get(id);
  if (timer) {
    clearTimeout(timer);
    pending.delete(id);
  }
}

// The hook is still awaiting a genuine completion iff its run is still running.
// Once finished/aborted (by another path or a prior advance) the gate no-ops.
function stillPending(id: string): boolean {
  return getPostMergeHook(id)?.status === 'running';
}

// Request a Stop-hook-driven finish of the post-merge hook `id`. Idempotent and
// safe to call repeatedly as duplicate/premature Stops arrive: each call feeds
// the Stop in as a fresh signal (extending the settle window) but only one poll
// loop runs per hook. `finish` is invoked at most once, when the session goes
// quiescent while the hook is still running.
export function requestPostMergeHookStopComplete(
  id: string,
  finish: () => void,
  timing: GateTiming = {
    settleMs: PMH_STOP_HOOK_SETTLE_MS,
    pollMs: PMH_STOP_HOOK_POLL_MS,
  },
  // `rearm`: boot recovery restarting the gate for a Stop the previous process
  // had received (PostMergeHookRun.stopReceivedAt) — not a new Stop, so it must
  // not restart the quiet window at "now".
  opts: { rearm?: boolean } = {},
): void {
  if (!stillPending(id)) return;

  const agentId = postMergeHookAgentId(id);
  // Count this Stop as a signal so the settle window is measured from the most
  // recent Stop, not just from tool/subagent activity — repeated Stops keep
  // pushing the window out until they stop coming.
  if (!opts.rearm) noteAgentStop(agentId);

  if (pending.has(id)) return; // poll already running

  const tick = (): void => {
    if (!stillPending(id)) {
      clearGate(id);
      return;
    }
    if (isAgentQuiescent(agentId, timing.settleMs)) {
      clearGate(id);
      finish();
      return;
    }
    // Still working: persist when it was last seen busy, so a restart re-arms
    // this gate from that rather than from the Stop (markAgentReadopted).
    noteHeldStopActivity(id, agentId);
    schedule(); // keep waiting
  };

  const schedule = (): void => {
    const timer = setTimeout(tick, timing.pollMs);
    timer.unref?.();
    pending.set(id, timer);
  };

  // Replace any stale gate (defensive) and start the poll loop.
  clearGate(id);
  schedule();
}

// Throttled persistence of a holding gate's last-busy time (see the workflow
// gate's HELD_STOP_ACTIVITY_PERSIST_MS).
const HELD_ACTIVITY_PERSIST_MS = 15_000;
const heldActivityPersistedAt = new Map<string, number>();

function noteHeldStopActivity(id: string, agentId: string): void {
  const run = getPostMergeHook(id);
  if (!run || run.stopReceivedAt === undefined) return;
  const now = Date.now();
  if (now - (heldActivityPersistedAt.get(id) ?? 0) < HELD_ACTIVITY_PERSIST_MS) return;
  const { activeAt, busy } = agentHeldActivity(agentId, HELD_ACTIVITY_PERSIST_MS);
  if (activeAt <= (run.stopActiveAt ?? run.stopReceivedAt)) return;
  heldActivityPersistedAt.set(id, now);
  patchPostMergeHook(id, { stopActiveAt: activeAt, stopBusy: busy });
}

// The finish a gated (Stop-sourced, non-error) completion performs: drop the
// graph node + quiescence state, finalize the hook (resolving the merge-run /
// Phase C waiters), then clean up scratch off the response path. Shared by the
// `/complete` route and by boot recovery re-arming a held Stop.
export function postMergeHookStopFinish(id: string, projectPath: string): () => void {
  const agentId = postMergeHookAgentId(id);
  return () => {
    unregisterAgentSession(agentId);
    forgetAgentQuiescence(agentId);
    finishPostMergeHook(id, 'completed');
    void cleanupPostMergeHookSession(projectPath, id);
  };
}

// Cancel a pending gate (hook finished by another path / aborted). No-op if
// none is pending.
export function cancelPostMergeHookStopGate(id: string): void {
  clearGate(id);
}
