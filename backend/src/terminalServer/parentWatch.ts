// Self-terminate when the backend that spawned us is gone.
//
// The terminal-server runs detached so its PTYs (and the Claude agents
// inside them) survive backend dev restarts. The cost: if the backend
// exits ungracefully (Ctrl+C in a parent shell, OS reboot interrupting,
// a crash without /shutdown), nothing reaps the terminal-server — it
// just keeps running with a dangling fingerprint that the *next* backend
// boot will detect and shutdownStale, but the orphan eats RAM and a
// port until then. Worse, if the user reuses the same checkout (same
// fingerprint), the orphan is treated as healthy and reused — including
// any wedged state it might have accumulated.
//
// `BACKEND_PARENT_PID` is the PID of the long-lived dev orchestrator
// (`scripts/dev.mjs` / `scripts/orchestrate.mjs` in dev, or `node
// dist/index.js` in prod). It stays the same across backend dist
// restarts, so we don't terminate during normal tsc-w respawns; only if
// the orchestrator itself is gone do we shut down.

const POLL_INTERVAL_MS = 5_000;

export function watchParentProcess(
  parentPid: number,
  onParentGone: () => void,
): void {
  if (!parentPid || !Number.isFinite(parentPid) || parentPid <= 0) return;

  const timer = setInterval(() => {
    if (isProcessAlive(parentPid)) return;
    console.warn(
      `[lattice-terminal] backend parent pid ${parentPid} is gone — self-terminating to avoid orphan accumulation`,
    );
    clearInterval(timer);
    onParentGone();
  }, POLL_INTERVAL_MS);
  timer.unref();
}

function isProcessAlive(pid: number): boolean {
  try {
    // Signal 0 is a no-op kill: throws ESRCH if the pid is dead, EPERM
    // if alive-but-not-ours (good enough — alive). Works on both POSIX
    // and Windows (libuv emulates kill 0 by querying OpenProcess).
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EPERM') return true;
    return false;
  }
}

