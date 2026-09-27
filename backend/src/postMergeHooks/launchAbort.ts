// Per-hook cancellation of the launch window (scratch setup + queued pty
// spawn). The run is recorded before its pty exists, and the spawn can wait a
// long time in the queue (priority band full, terminal-server unreachable, a
// restart drain). Marking the run `aborted` alone left that queue request
// alive: the trigger's caller (a merge run holding run.lock, a manual /merge,
// a resolver /complete) stayed blocked on it, which is exactly what Abort
// exists to undo. `endPostMergeHook` aborts the hook's signal here, which
// `queuedCreateSession` turns into a queue cancel (a pending request is
// dropped at once; an in-flight creation is killed as soon as it returns).

const launches = new Map<string, AbortController>();

// Called by the trigger right after recording the run. `release` must run once
// the launch is over (spawned, failed or aborted) so a finished hook's abort
// never reaches a stale controller.
export function trackPostMergeHookLaunch(id: string): {
  signal: AbortSignal;
  release: () => void;
} {
  const controller = new AbortController();
  launches.set(id, controller);
  return {
    signal: controller.signal,
    release: () => {
      if (launches.get(id) === controller) launches.delete(id);
    },
  };
}

// Cancel the hook's still-pending launch, if it has one. No-op once the pty is
// up (the launch was released) — that session is killed by its serverId.
export function abortPostMergeHookLaunch(id: string, reason: string): boolean {
  const controller = launches.get(id);
  if (!controller) return false;
  launches.delete(id);
  controller.abort(new Error(`post-merge hook ${id} ${reason}`));
  return true;
}
