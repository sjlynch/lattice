import { useEffect } from 'react';
import type { RefObject } from 'react';
import type { Terminal } from '@xterm/xterm';
import { useSyncedRef } from '../../hooks/useSyncedRef';
import type { TerminalStatus } from '../../terminal/terminalTypes';

// Reconnect cap for a SERVERLESS terminal that has never attached: without a
// session id to re-subscribe to, each fresh connect can spawn a brand-new pty,
// so unbounded retries there could leak orphan ptys if the connect flaps. A
// terminal we CAN re-attach to (it has a serverId, or captured one via a prior
// `attached`) is not capped — see the onclose handler.
export const MAX_RECONNECT_ATTEMPTS = 6;
// Backoff ceiling. Delays grow 250ms → 500 → … and then hold here, so a long
// outage keeps being retried roughly every 10s rather than giving up.
const RECONNECT_MAX_DELAY_MS = 10_000;

type TerminalMessage = {
  type?: string;
  data?: string;
  id?: string;
  replayed?: boolean;
  message?: string;
  exitCode?: number;
};

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
    // messages below; never influences reconnect behaviour.
    const reportStatus = (status: TerminalStatus, exitCode?: number) => {
      onStatusRef.current?.(status, exitCode);
    };

    function connect() {
      if (cancelled || terminated) return;
      const params = new URLSearchParams({
        cwd,
        cols: String(term.cols),
        rows: String(term.rows),
      });
      if (serverId) params.set('id', serverId);
      // Only forward initialCommand when we're creating a fresh session.
      // For a known serverId the backend already ran the initial command
      // when it pre-spawned the pty; passing it again would be a no-op
      // (terminal.ts ignores it on replay) but it's needless noise.
      if (!serverId && initialCommand) params.set('initialCommand', initialCommand);
      if (projectPath) params.set('projectPath', projectPath);

      const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
      ws = new WebSocket(
        `${proto}://${window.location.host}/ws/terminal?${params.toString()}`,
      );

      ws.onopen = () => {
        attempt = 0;
        if (reconnectingShown) {
          term.write('\r\n\x1b[2m[reconnected]\x1b[0m\r\n');
          reconnectingShown = false;
        }
        reportStatus('live');
      };

      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data) as TerminalMessage;
          if (msg.type === 'data' && typeof msg.data === 'string') {
            term.write(msg.data);
          } else if (msg.type === 'attached') {
            attachedOnce = true;
            if (msg.id && msg.id !== serverId) {
              onServerIdRef.current?.(msg.id);
            }
            if (msg.replayed === false) {
              // Brand new session — clear any leftover xterm content.
              term.clear();
            }
          } else if (msg.type === 'error') {
            term.write(`\r\n\x1b[31m${msg.message}\x1b[0m\r\n`);
          } else if (msg.type === 'exit') {
            term.write(`\r\n\x1b[2m[exited ${msg.exitCode}]\x1b[0m\r\n`);
            // The pty is gone for good. Mark terminated so the WS close
            // that follows doesn't trigger a reconnect (which on a
            // cleaned-up worktree would create a doomed-to-exit pty,
            // feeding back into another close → another reconnect →
            // runaway).
            terminated = true;
            reportStatus('exited', msg.exitCode);
          } else if (msg.type === 'session_lost') {
            term.write(
              `\r\n\x1b[2m[${msg.message ?? 'session lost'}]\x1b[0m\r\n`,
            );
            terminated = true;
            reportStatus('dead');
          }
        } catch {
          /* ignore */
        }
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
        const canReattach = Boolean(serverId) || attachedOnce;
        if (!canReattach && attempt >= MAX_RECONNECT_ATTEMPTS) {
          // Serverless terminal that never attached: a reconnect here can spawn
          // a fresh pty, so it must stay bounded.
          term.write(
            '\r\n\x1b[31m[connection lost — gave up after ' +
              MAX_RECONNECT_ATTEMPTS +
              ' reconnect attempts. Close this tab and start a new terminal if needed.]\x1b[0m\r\n',
          );
          terminated = true;
          reportStatus('dead');
          return;
        }
        if (!reconnectingShown) {
          term.write(
            '\r\n\x1b[2m[connection lost — reconnecting…]\x1b[0m\r\n',
          );
          reconnectingShown = true;
          reportStatus('reconnecting');
        }
        // Cap the exponent so the delay tops out at the ceiling instead of
        // overflowing once `attempt` grows large during a long outage.
        const delay = Math.min(
          RECONNECT_MAX_DELAY_MS,
          250 * 2 ** Math.min(attempt, 6),
        );
        attempt += 1;
        retryTimer = setTimeout(connect, delay);
      };
    }

    const dataDisposable = term.onData((data) => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'input', data }));
      }
    });

    const resizeDisposable = term.onResize(({ cols, rows }) => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'resize', cols, rows }));
      }
    });

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
      dataDisposable.dispose();
      resizeDisposable.dispose();
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
