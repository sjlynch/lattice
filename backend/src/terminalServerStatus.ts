// Is the running terminal-server (the detached PTY executor) the build this
// backend expects? When the executor's files changed, `ensureTerminalServer`
// only swaps it once it has ZERO sessions (`shutdown-if-idle`) — with the
// user's own terminals always open that can be never, and the one-time console
// warning is easy to miss. This read-only status backs the navbar's "terminal
// server update pending" chip (`GET /api/terminal-server/status`).
//
// Never triggers the upgrade itself: that stays with the next session create /
// terminal connect, which already calls `ensureTerminalServer`.

import { EXPECTED_TERMINAL_FINGERPRINT, probeTerminalServer } from './terminalServerLifecycle.js';
import { proxyCountSessions } from './terminalServerClient.js';

export type TerminalServerStatus = {
  /**
   * `current` — the executor runs this backend's build; `stale` — an older
   * build is kept alive to preserve its terminals (update pending); `absent` —
   * nothing listening (spawned on the next terminal); `unavailable` — the port
   * answered but not as a usable terminal-server.
   */
  state: 'current' | 'stale' | 'absent' | 'unavailable';
  /** Live PTY sessions on a `stale` executor; null when not counted (or uncountable). */
  sessions: number | null;
};

export async function getTerminalServerStatus(deps: {
  probe?: typeof probeTerminalServer;
  count?: () => Promise<number | null>;
  expectedFingerprint?: string;
} = {}): Promise<TerminalServerStatus> {
  const probe = await (deps.probe ?? probeTerminalServer)();
  if (probe.kind === 'absent') return { state: 'absent', sessions: 0 };
  if (probe.kind === 'unavailable') return { state: 'unavailable', sessions: null };
  const expected = deps.expectedFingerprint ?? EXPECTED_TERMINAL_FINGERPRINT;
  if (probe.info.fingerprint === expected) return { state: 'current', sessions: null };
  return { state: 'stale', sessions: await (deps.count ?? proxyCountSessions)() };
}
