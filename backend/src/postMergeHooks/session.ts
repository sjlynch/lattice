import {
  finishPostMergeHook,
  getPostMergeHook,
  waitForPostMergeHook,
} from './registry.js';
import {
  triggerPostMergeHook,
  type TriggerPostMergeHookOptions,
} from './trigger.js';
import { postMergeHookAgentId } from './stopHook.js';
import { cancelPostMergeHookStopGate } from './stopHookGate.js';
import { cleanupPostMergeHookSession } from './cleanup.js';
import { isPostMergeHookOwed } from './owed.js';
import { unregisterAgentSession } from '../agentSessions.js';
import { forgetAgentQuiescence } from '../agentQuiescence.js';
import { proxyKillSession } from '../terminalProxy.js';
import type { PostMergeHookRun, PostMergeHookStatus } from './types.js';

// Upper bound on how long a merge waits for the hook agent to call back. The
// registry waiter has no view of the pty, so a hook whose agent crashed / was
// killed / had its tab closed never resolves on its own — and that parked the
// merge run (run.lock held, a workflow Merge step stuck in
// `waitForMergeRunFinished`) forever. Same 30 min the workflow Merge step's
// Phase C gives a hook (`PHASE_C_HOOK_TIMEOUT_MS`).
export const POST_MERGE_HOOK_MAX_WAIT_MS = 30 * 60 * 1000;

// End a still-running hook from OUTSIDE its own completion callback: the user's
// Abort button, a sidebar tab close on its pty, or the wait above expiring.
// One place for the teardown the /complete route otherwise does — drop the
// stale Stop-hook gate, the graph node and the quiescence state, kill the pty
// (unless the caller already did), finish the run so every waiter unblocks,
// then remove the scratch dir off the caller's path. Idempotent: `finish` is a
// no-op on a hook that already reached a terminal status, and the pty kill /
// scratch removal are safe to repeat.
export async function endPostMergeHook(
  id: string,
  status: Exclude<PostMergeHookStatus, 'running'>,
  reason: string,
  opts: { killSession?: boolean } = {},
): Promise<PostMergeHookRun | null> {
  const agentId = postMergeHookAgentId(id);
  cancelPostMergeHookStopGate(id);
  forgetAgentQuiescence(agentId);
  unregisterAgentSession(agentId);
  const existing = getPostMergeHook(id);
  if (!existing) return null;
  if (opts.killSession !== false && existing.serverId) {
    try {
      await proxyKillSession(existing.serverId);
    } catch {
      /* best-effort */
    }
  }
  const finished = finishPostMergeHook(id, status, reason);
  void cleanupPostMergeHookSession(existing.projectPath, existing.id);
  return finished;
}

// Convenience: trigger + await. Returns the terminal run state. Used by the
// merge-run finisher and per-task finalize so they can simply
// `await runPostMergeHookGate(...)` to block their own completion.
//
// This is the thin coordinator that ties the two halves together:
// `triggerPostMergeHook` (trigger.ts) decides whether/how to start a hook —
// itself delegating the scratch-dir + installation work to
// `setupPostMergeHookSession` (sessionSetup.ts) — and this gate then blocks on
// the run finishing so the merge isn't considered complete until it does.
export async function runPostMergeHookGate(
  options: TriggerPostMergeHookOptions,
  maxWaitMs: number = POST_MERGE_HOOK_MAX_WAIT_MS,
): Promise<PostMergeHookRun | null> {
  // An `already-running` hook may predate the merges this call is for (or be a
  // dead record boot restored as running for its lost-grace window), so the
  // trigger leaves the owed marker set (owed.ts): wait that hook out, and if
  // the debt is still there, fire a fresh one for these merges. Bounded — a
  // project whose hooks keep overlapping new merges must not loop forever.
  let last: PostMergeHookRun | null = null;
  for (let round = 0; round < 3; round++) {
    const { run, waitedOnExisting } = await runPostMergeHookGateOnce(options, maxWaitMs);
    last = run ?? last;
    if (!waitedOnExisting || !(await isPostMergeHookOwed(options.projectPath))) break;
  }
  return last;
}

async function runPostMergeHookGateOnce(
  options: TriggerPostMergeHookOptions,
  maxWaitMs: number,
): Promise<{ run: PostMergeHookRun | null; waitedOnExisting: boolean }> {
  const outcome = await triggerPostMergeHook(options);
  const done = (run: PostMergeHookRun | null) => ({ run, waitedOnExisting: false });
  // 'no-prompt' (nothing to run) and 'disabled' (master toggle off) are both
  // no-ops — the merge completes without gating on a hook.
  if (
    outcome.kind === 'skipped' &&
    (outcome.reason === 'no-prompt' || outcome.reason === 'disabled')
  ) {
    return done(null);
  }
  if (outcome.kind === 'skipped' && outcome.reason === 'aborted') {
    // Aborted while its session was still being set up / queued: the trigger
    // already tore the session down and the run is terminal.
    return done(outcome.run);
  }
  if (outcome.kind === 'error') {
    // Don't block forever on a failed spawn — surface and return.
    return done(null);
  }
  // 'already-running': another caller started a hook for this project; await
  // it exactly as we would our own.
  const run = outcome.kind === 'skipped' ? outcome.existing : outcome.run;
  const result = await waitForPostMergeHook(run.id, maxWaitMs);
  if (result === 'expired') {
    // The registry already finished it `errored`; reclaim the session so a
    // hung agent doesn't linger in the terminal-server.
    await endPostMergeHook(run.id, 'errored', 'timed out', { killSession: true });
  }
  return { run: getPostMergeHook(run.id) ?? run, waitedOnExisting: outcome.kind === 'skipped' };
}
