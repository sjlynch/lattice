// Post-loop finalize for a merge run: run the worker body to completion, release
// the cross-process project run-lock, and ONLY THEN auto-restart for tasks that
// became ready_to_merge while the run was in flight.
//
// The ordering is the whole point of this module. The restart used to fire
// inline from runTeardown (teardown.ts) — while the run was still
// status==='running' and still owned the cross-process run-lock — so the
// restarted startMergeRun hit the in-process 409 gate (lifecycle.ts
// initializeRunState) / couldn't steal the live lock, and the throw was
// swallowed by restartMergeRun's `.catch(() => {})`. The newly-ready tasks then
// sat at ready_to_merge until a manual 'merge all', with no boot-time fallback
// (a cleanly-completed run leaves no stale lock for resumeInterruptedMergeRuns).
//
// Deferring the restart to after releaseLock() resolves — and after finishRun
// (inside `body`) has flipped status away from 'running' — lets the fresh run's
// in-process and cross-process gates pass.

export type FinalizeMergeRunArgs = {
  // Runs preflight + the per-target loop + teardown + post-merge hook +
  // finishRun. Resolves to whether a fresh run should be started for tasks that
  // became ready mid-run.
  body: () => Promise<boolean>;
  // Handles a worker crash (sets the run errored + notifies). A crash suppresses
  // the restart — the next manual merge-all (or boot resume) picks up stragglers.
  onError: (err: unknown) => void;
  // Releases the cross-process project run-lock (a no-op when the lock was
  // inherited). Always awaited, even on a worker crash.
  releaseLock: () => Promise<void>;
  // Starts a fresh merge run. Invoked at most once, strictly AFTER releaseLock()
  // has resolved, and never on a crash.
  restart: () => void;
};

export async function finalizeMergeRun({
  body,
  onError,
  releaseLock,
  restart,
}: FinalizeMergeRunArgs): Promise<void> {
  let shouldRestart = false;
  try {
    shouldRestart = await body();
  } catch (err) {
    onError(err);
    shouldRestart = false;
  } finally {
    await releaseLock();
  }
  if (shouldRestart) restart();
}
