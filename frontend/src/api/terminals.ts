import { subscribeWsShared } from './ws';

export type TerminalActivityMessage = {
  type: 'terminal-activity';
  // Backend session ids (`TerminalSpec.serverId`) whose harness is still
  // emitting output. Machine-wide, not project-filtered — the sidebar
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
 * derived.
 */
export function subscribeTerminalActivity(
  project: string,
  onBusy: (busyServerIds: string[]) => void,
): () => void {
  return subscribeWsShared<TerminalActivityMessage>(
    `/ws/terminal-activity?project=${encodeURIComponent(project)}`,
    (msg) => {
      if (msg?.type !== 'terminal-activity' || !Array.isArray(msg.busy)) return;
      onBusy(msg.busy);
    },
    (msg) => msg?.type === 'terminal-activity',
  );
}
