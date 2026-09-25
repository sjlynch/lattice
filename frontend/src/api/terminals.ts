import { asJson } from './http';
import { subscribeWsShared } from './ws';

export type TerminalActivityMessage = {
  type: 'terminal-activity';
  // Backend session ids (`TerminalSpec.serverId`) whose harness is still
  // working. Machine-wide, not project-filtered — the sidebar
  // intersects it with its own project-scoped tab list.
  busy: string[];
};

/**
 * Live "which agents are still working" feed (`/ws/terminal-activity`).
 *
 * Pushed once on connect and again on every change, so a sidebar tab can swap
 * its icon for a spinner even when its `TerminalPane` was never mounted — which
 * is the whole point, since an un-clicked tab has no terminal WebSocket of its
 * own to watch. See `backend/src/terminalActivity.ts` for how the signal is
 * derived. A disconnected feed clears this ephemeral indicator and its replay
 * cache; the next connection must supply a fresh snapshot.
 */
export function subscribeTerminalActivity(
  project: string,
  onBusy: (busyServerIds: string[]) => void,
): () => void {
  return subscribeWsShared<TerminalActivityMessage>(
    `/ws/terminal-activity?project=${encodeURIComponent(project)}`,
    (msg) => {
      if (msg?.type !== 'terminal-activity' || !Array.isArray(msg.busy)) return;
      // Normalize the wire set so duplicate/invalid ids cannot preserve stale
      // members in the hook's equality check.
      onBusy([...new Set(msg.busy.filter((id) => typeof id === 'string' && id.length > 0))]);
    },
    (msg) => msg?.type === 'terminal-activity' && Array.isArray(msg.busy),
    { onDisconnect: () => onBusy([]), resetReplayOnDisconnect: true },
  );
}

export type TerminalServerStatus = {
  // `stale`: the detached terminal-server runs an older build than the backend
  // and is kept alive to preserve its terminals — the update applies once it
  // has no sessions. See backend/src/terminalServerStatus.ts.
  state: 'current' | 'stale' | 'absent' | 'unavailable';
  // Live pty sessions on a stale executor; null when not counted.
  sessions: number | null;
};

/** Executor build status behind the navbar's "update pending" chip. */
export async function fetchTerminalServerStatus(): Promise<TerminalServerStatus> {
  return asJson<TerminalServerStatus>(await fetch('/api/terminal-server/status'));
}
