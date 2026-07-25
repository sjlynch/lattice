// Quiescence gate for the Claude Stop-hook post-merge-hook completion callback.
//
// Why this exists: a post-merge hook is an arbitrary full agent task (it may
// use the Task tool / subagents), and its Claude session reports completion via
// the `Stop` hook POSTing `/api/post-merge-hooks/:id/complete`. But Claude's
// `Stop` hook is NOT a reliable "session fully done" signal when the agent uses
// subagents — it fires early and repeatedly (reproduced against Claude Code
// 2.1.218; see `agentQuiescence.ts` + the workflow analogue in
// `workflowRuns/stopHookGate.ts`). A premature Stop used to finish the hook
// immediately: the merge run's `waitForPostMergeHook` waiter resolved, the run
// reported `completed`, and the workflow Merge step's Phase C observed the hook
// as no longer running and advanced — so the frontend sequential queue
// dispatched the next workflow's step 1 on top of the still-working post-merge
// agent. This is exactly the overlap the workflow-step quiescence gate prevents,
// just extended to post-merge hooks.
//
// The fix, applied only to the Stop-hook-sourced completion (the model's own
// explicit curl `source=model-explicit-curl`, Pi's `session_shutdown` extension,
// and Codex's `Stop` hook are deliberate end-of-work signals and keep finishing
// immediately): don't finish on the Stop itself. Instead wait until the session
// is QUIESCENT — no subagents in flight and no signal of any kind (tool use,
// subagent start/stop, or a later Stop) for a short settle window. Because the
// real Stop always arrives last and premature Stops are followed by more
// activity and/or the final Stop, the quiet window lands on the genuine end of
// the hook. `agentQuiescence.ts` supplies the per-session liveSubagents /
// lastSignalAt this reads; the agent-activity route feeds it from the same
// hooks that already drive the graph (extended to the `pmh:` agent id).

import { getPostMergeHook } from './registry.js';
import { postMergeHookAgentId } from './stopHook.js';
import { agentQuiescence, noteAgentSignal } from '../agentQuiescence.js';

// Finish only after the session has been fully quiet (no subagents live, no
// signal) for this long. Long enough to bridge the gap between a premature Stop
// and the real one, short enough to add only a small tail to the hook's runtime.
export const PMH_STOP_HOOK_SETTLE_MS = 4000;
// How often to re-check quiescence while waiting.
export const PMH_STOP_HOOK_POLL_MS = 1000;

type GateTiming = { settleMs: number; pollMs: number };

const pending = new Map<string, ReturnType<typeof setTimeout>>();

function clearGate(id: string): void {
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
): void {
  if (!stillPending(id)) return;

  const agentId = postMergeHookAgentId(id);
  // Count this Stop as a signal so the settle window is measured from the most
  // recent Stop, not just from tool/subagent activity — repeated Stops keep
  // pushing the window out until they stop coming.
  noteAgentSignal(agentId);

  if (pending.has(id)) return; // poll already running

  const tick = (): void => {
    if (!stillPending(id)) {
      clearGate(id);
      return;
    }
    const q = agentQuiescence(agentId);
    if (q.liveSubagents === 0 && q.quietForMs >= timing.settleMs) {
      clearGate(id);
      finish();
      return;
    }
    schedule(); // still working (subagent live or recent signal) — keep waiting
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

// Cancel a pending gate (hook finished by another path / aborted). No-op if
// none is pending.
export function cancelPostMergeHookStopGate(id: string): void {
  clearGate(id);
}
