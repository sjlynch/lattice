import { useEffect } from 'react';
import type { RefObject } from 'react';
import type { Terminal } from '@xterm/xterm';
import { useSyncedRef } from '../../hooks/useSyncedRef';
import type { TerminalStatus } from '../../terminal/terminalTypes';
import {
  MAX_RECONNECT_ATTEMPTS,
  buildTerminalWsUrl,
  forwardTerminalInput,
  handleTerminalMessage,
  terminalNotices,
} from './terminalSocket';
import { createTerminalReconnectController } from './terminalReconnectController';

// Re-exported for back-compat: the cap itself lives in ./terminalSocket, while
// the reconnect lifecycle state machine now lives in ./terminalReconnectController.
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
  // The serverId is read through a ref too. A serverless terminal CAPTURES its
  // id from the first `attached` frame (onServerId → parent state → new prop);
  // reading it via a ref keeps the live WS (and the single Terminal) intact on
  // capture instead of tearing the effect down and reopening a second WS. The
  // ref still feeds the latest id into a later reconnect so it re-attaches to
  // the existing pty by id rather than spawning a fresh one.
  const serverIdRef = useSyncedRef(serverId);

  useEffect(() => {
    const term = termRef.current!;
    if (!term) return;

    let ws: WebSocket | null = null;

    const controller = createTerminalReconnectController({
      getServerId: () => serverIdRef.current,
      reconnect: () => connect(),
      setTimer: (callback, delay) => setTimeout(callback, delay),
      clearTimer: (timer) => clearTimeout(timer),
      // Notify the parent of a health transition. Mirrors the terminal-body
      // notices; never influences reconnect behaviour.
      onStatus: (status: TerminalStatus, exitCode?: number) => {
        onStatusRef.current?.(status, exitCode);
      },
      onReconnected: () => terminalNotices.reconnected(term),
      onReconnecting: () => terminalNotices.reconnecting(term),
      onGaveUp: () => terminalNotices.gaveUp(term),
    });

    function connect() {
      if (!controller.canConnect()) return;
      // Read the latest serverId from the ref: if we captured one via an earlier
      // `attached` frame, a reconnect re-attaches to that EXISTING pty by id
      // (replay) instead of re-running initialCommand and spawning a fresh one.
      ws = new WebSocket(
        buildTerminalWsUrl({
          cwd,
          cols: term.cols,
          rows: term.rows,
          serverId: serverIdRef.current,
          initialCommand,
          projectPath,
        }),
      );

      ws.onopen = () => {
        controller.handleOpen();
      };

      ws.onmessage = (ev) => {
        handleTerminalMessage(ev.data, {
          term,
          // Compare an incoming `attached` id against the LATEST captured id so
          // a re-attach to the same pty doesn't re-fire onServerId.
          serverId: serverIdRef.current,
          onAttached: () => {
            controller.handleAttached();
          },
          onServerId: (id) => onServerIdRef.current?.(id),
          onTerminated: (status, exitCode) => {
            controller.handleTerminated(status, exitCode);
          },
        });
      };

      ws.onerror = () => {
        // onclose will fire too; reconnect is scheduled there.
      };

      ws.onclose = () => {
        controller.handleClose();
      };
    }

    const io = forwardTerminalInput(term, () => ws);

    // Defer the actual connect by one task tick so React StrictMode's
    // synchronous cleanup (which calls controller.cancel()) runs before we
    // initiate the WS handshake. Without this, the first effect run
    // opens a WS that the backend has already begun upgrading before
    // the cleanup can abort it — when we lack a serverId (a fresh
    // startup terminal), the backend creates a pty session that
    // outlives the cleanup. The second effect run then opens ANOTHER
    // serverless WS and creates a SECOND pty, both running the same
    // initialCommand. For port-binding commands like `npm run dev`,
    // the second fails with "address in use". This delay is also
    // production-safe — a 0 ms task hop is imperceptible.
    controller.startConnecting();
    const connectTimer = setTimeout(connect, 0);

    return () => {
      controller.cancel();
      clearTimeout(connectTimer);
      io.dispose();
      // Just close the WS — the backend keeps the pty alive so a refresh
      // (or remount) reattaches via the persisted serverId.
      try {
        ws?.close();
      } catch {
        /* ignore */
      }
    };
    // Depends only on [cwd, termRef]. Both `serverId` and `onServerId` are
    // intentionally excluded and read through refs (`serverIdRef`/`onServerIdRef`):
    // a serverless terminal captures its id from the first `attached` frame, and
    // adding serverId here would tear down the live WS — and, since the same
    // capture also recreates the Terminal — recreate the xterm front-end the
    // instant it connects (clear/flash, lost focus, a dropped keystroke, and a
    // churned WebGL context). Keep new dependencies out of this array unless a
    // change genuinely warrants reconnecting.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cwd, termRef]);
}
