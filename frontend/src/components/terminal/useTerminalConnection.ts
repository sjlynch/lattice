import { useEffect } from 'react';
import type { RefObject } from 'react';
import type { Terminal } from '@xterm/xterm';
import { useSyncedRef } from '../../hooks/useSyncedRef';
import type { TerminalStatus } from '../../terminal/terminalTypes';
import {
  MAX_RECONNECT_ATTEMPTS,
  buildTerminalWsUrl,
  canReattachTerminal,
  forwardTerminalInput,
  handleTerminalMessage,
  reconnectDelay,
  shouldGiveUpReconnect,
  terminalNotices,
} from './terminalSocket';

// Re-exported for back-compat: the cap itself, and the protocol mechanism it
// belongs to, now live in ./terminalSocket. This hook owns the connection state
// machine and orchestrates those focused helpers.
export { MAX_RECONNECT_ATTEMPTS };

type UseTerminalConnectionArgs = {
  termRef: RefObject<Terminal | null>;
  cwd: string;
  initialCommand?: string;
  serverId?: string;
  projectPath?: string;
  onServerId?: (id: string) => void;
  // Reports connection-health transitions so the sidebar tab can show an
  // indicator. Purely a notification — the hook's reconnect logic is unchanged.
  onStatus?: (status: TerminalStatus, exitCode?: number) => void;
};

export function useTerminalConnection({
  termRef,
  cwd,
  initialCommand,
  serverId,
  projectPath,
  onServerId,
  onStatus,
}: UseTerminalConnectionArgs) {
  // Keep latest callbacks in refs so we don't re-establish the WS just
  // because the parent re-rendered.
  const onServerIdRef = useSyncedRef(onServerId);
  const onStatusRef = useSyncedRef(onStatus);

  useEffect(() => {
    const term = termRef.current!;
    if (!term) return;

    let ws: WebSocket | null = null;
    let cancelled = false;
    let attempt = 0;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let reconnectingShown = false;
    // Once the pty has signalled it is gone (clean exit, or backend says
    // session_lost), stop reconnecting. Without this, every WS close —
    // including the one immediately following a clean pty exit — would
    // trigger a fresh connect, which on a deleted-worktree session
    // produces a feedback loop that spawns thousands of doomed ptys.
    let terminated = false;
    // True once this connection has received an `attached` frame — i.e. the
    // terminal-server owns a live pty that a reconnect just re-subscribes to
    // (idempotent). Lets a terminal that started life serverless still
    // reconnect indefinitely, since it captured a session id on first attach.
    let attachedOnce = false;

    // Notify the parent of a health transition. Mirrors the terminal-body
    // notices; never influences reconnect behaviour.
    const reportStatus = (status: TerminalStatus, exitCode?: number) => {
      onStatusRef.current?.(status, exitCode);
    };

    function connect() {
      if (cancelled || terminated) return;
      ws = new WebSocket(
        buildTerminalWsUrl({
          cwd,
          cols: term.cols,
          rows: term.rows,
          serverId,
          initialCommand,
          projectPath,
        }),
      );

      ws.onopen = () => {
        attempt = 0;
        if (reconnectingShown) {
          terminalNotices.reconnected(term);
          reconnectingShown = false;
        }
        reportStatus('live');
      };

      ws.onmessage = (ev) => {
        handleTerminalMessage(ev.data, {
          term,
          serverId,
          onAttached: () => {
            attachedOnce = true;
          },
          onServerId: (id) => onServerIdRef.current?.(id),
          onTerminated: (status, exitCode) => {
            terminated = true;
            reportStatus(status, exitCode);
          },
        });
      };

      ws.onerror = () => {
        // onclose will fire too; reconnect is scheduled there.
      };

      ws.onclose = () => {
        if (cancelled || terminated) return;
        // A terminal we can re-attach to (has a serverId, or captured one via
        // an earlier `attached` this session) reconnects to its EXISTING pty —
        // idempotent and safe to retry forever. So ride out a transient outage
        // (main-backend restart/stall, or a wedged upstream proxy under a heavy
        // "Run All" burst) with capped backoff instead of giving up and forcing
        // a manual page refresh. The genuine stop is `terminated`, set on a
        // clean `exit` or a `session_lost` — that is what bounds the deleted-
        // worktree runaway, not an attempt count.
        const canReattach = canReattachTerminal(serverId, attachedOnce);
        if (shouldGiveUpReconnect(canReattach, attempt)) {
          // Serverless terminal that never attached: a reconnect here can spawn
          // a fresh pty, so it must stay bounded.
          terminalNotices.gaveUp(term);
          terminated = true;
          reportStatus('dead');
          return;
        }
        if (!reconnectingShown) {
          terminalNotices.reconnecting(term);
          reconnectingShown = true;
          reportStatus('reconnecting');
        }
        const delay = reconnectDelay(attempt);
        attempt += 1;
        retryTimer = setTimeout(connect, delay);
      };
    }

    const io = forwardTerminalInput(term, () => ws);

    // Defer the actual connect by one task tick so React StrictMode's
    // synchronous cleanup (which sets cancelled=true) runs before we
    // initiate the WS handshake. Without this, the first effect run
    // opens a WS that the backend has already begun upgrading before
    // the cleanup can abort it — when we lack a serverId (a fresh
    // startup terminal), the backend creates a pty session that
    // outlives the cleanup. The second effect run then opens ANOTHER
    // serverless WS and creates a SECOND pty, both running the same
    // initialCommand. For port-binding commands like `npm run dev`,
    // the second fails with "address in use". This delay is also
    // production-safe — a 0 ms task hop is imperceptible.
    reportStatus('connecting');
    const connectTimer = setTimeout(connect, 0);

    return () => {
      cancelled = true;
      clearTimeout(connectTimer);
      if (retryTimer) clearTimeout(retryTimer);
      io.dispose();
      // Just close the WS — the backend keeps the pty alive so a refresh
      // (or remount) reattaches via the persisted serverId.
      try {
        ws?.close();
      } catch {
        /* ignore */
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cwd, serverId, termRef]);
}
