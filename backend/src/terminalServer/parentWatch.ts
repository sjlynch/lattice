// Self-terminate when the backend that spawned us is gone — but only once that
// is safe. The terminal-server runs detached so its PTYs (and agents) survive
// backend restarts; after an ungraceful backend exit nothing reaps it, and the
// orphan holds RAM and a port until the next boot's shutdownStale.
//
// `BACKEND_PARENT_PID` is the parent of the backend that spawned this server
// (`backend/scripts/dev.mjs` in dev, whatever launched `node dist/index.js` in
// prod). It stays the same across backend dist restarts, so normal tsc-w
// respawns don't terminate us. It does NOT survive a dev soft restart (`r`),
// which replaces the dev runner while this server and its agents live on; from
// then on the parent is simply "gone" and only the contact/idle rule applies.
//
// Parent gone is NOT enough on its own: stopping the dev runner mid-workflow
// would kill every running agent — the one thing the detached design exists to
// prevent (an idle orphan costs RAM; a killed agent costs its work). So once the
// parent is gone the watch keeps polling and lets the caller decide each tick
// (`tryShutdown`): exit only when no backend has contacted it recently (a newer
// backend adopts an existing server without changing BACKEND_PARENT_PID) AND it
// has no live or starting sessions.

const POLL_INTERVAL_MS = 5_000;

export function watchParentProcess(
  parentPid: number,
  // Called on every tick after the parent is gone. Return true once it has
  // shut the server down (the watch then stops); false to keep watching.
  tryShutdown: () => boolean,
  pollIntervalMs = POLL_INTERVAL_MS,
  isAlive: (pid: number) => boolean = isProcessAlive,
): void {
  if (!parentPid || !Number.isFinite(parentPid) || parentPid <= 0) return;

  let reported = false;
  const timer = setInterval(() => {
    // Sticky once gone: after a dev soft restart (or any runner replacement)
    // the parent pid is dead for good, and Windows recycles pids quickly — a
    // later unrelated process on the same pid must not read as "parent back",
    // or an idle, unowned server would never exit.
    if (!reported && isAlive(parentPid)) return;
    if (!reported) {
      reported = true;
      console.warn(
        `[lattice-terminal] backend parent pid ${parentPid} is gone — will self-terminate once idle and unowned`,
      );
    }
    if (tryShutdown()) clearInterval(timer);
  }, pollIntervalMs);
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
