import { waitForPostMergeHook } from './registry.js';
import {
  triggerPostMergeHook,
  type TriggerPostMergeHookOptions,
} from './trigger.js';
import type { PostMergeHookRun } from './types.js';

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
): Promise<PostMergeHookRun | null> {
  const outcome = await triggerPostMergeHook(options);
  // 'no-prompt' (nothing to run) and 'disabled' (master toggle off) are both
  // no-ops — the merge completes without gating on a hook.
  if (
    outcome.kind === 'skipped' &&
    (outcome.reason === 'no-prompt' || outcome.reason === 'disabled')
  ) {
    return null;
  }
  if (outcome.kind === 'skipped' && outcome.reason === 'already-running') {
    // Another caller already started a hook for this project; await it.
    await waitForPostMergeHook(outcome.existing.id);
    return outcome.existing;
  }
  if (outcome.kind === 'error') {
    // Don't block forever on a failed spawn — surface and return.
    return null;
  }
  await waitForPostMergeHook(outcome.run.id);
  return outcome.run;
}
