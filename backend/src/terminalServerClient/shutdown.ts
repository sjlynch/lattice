import { BASE } from '../terminalServerLifecycle.js';

// Tell the detached terminal server to kill all sessions and exit. Called
// by the dev orchestrator on Ctrl+C; the terminal server does not naturally
// receive that signal because it's detached + unref'd by design (so backend
// restarts don't kill PTYs).
const SHUTDOWN_POST_TIMEOUT_MS = 2_000;

export async function proxyShutdown(): Promise<void> {
  try {
    await fetch(`${BASE}/shutdown`, {
      method: 'POST',
      signal: AbortSignal.timeout(SHUTDOWN_POST_TIMEOUT_MS),
    });
  } catch {
    /* terminal server already down or unreachable — nothing to clean up */
  }
}
