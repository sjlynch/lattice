import { useEffect } from 'react';
import type { RefObject } from 'react';
import type { Terminal } from '@xterm/xterm';
import { useSyncedRef } from '../../hooks/useSyncedRef';

export const MAX_RECONNECT_ATTEMPTS = 6;

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
};

export function useTerminalConnection({
  termRef,
  cwd,
  initialCommand,
  serverId,
  projectPath,
  onServerId,
}: UseTerminalConnectionArgs) {
  // Keep latest callback in a ref so we don't re-establish the WS just
  // because the parent re-rendered.
  const onServerIdRef = useSyncedRef(onServerId);

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
      };

      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data) as TerminalMessage;
          if (msg.type === 'data' && typeof msg.data === 'string') {
            term.write(msg.data);
          } else if (msg.type === 'attached') {
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
          } else if (msg.type === 'session_lost') {
            term.write(
              `\r\n\x1b[2m[${msg.message ?? 'session lost'}]\x1b[0m\r\n`,
            );
            terminated = true;
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
        if (attempt >= MAX_RECONNECT_ATTEMPTS) {
          term.write(
            '\r\n\x1b[31m[connection lost — gave up after ' +
              MAX_RECONNECT_ATTEMPTS +
              ' reconnect attempts. Close this tab and start a new terminal if needed.]\x1b[0m\r\n',
          );
          terminated = true;
          return;
        }
        if (!reconnectingShown) {
          term.write(
            '\r\n\x1b[2m[connection lost — reconnecting…]\x1b[0m\r\n',
          );
          reconnectingShown = true;
        }
        const delay = Math.min(5000, 250 * 2 ** attempt);
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
