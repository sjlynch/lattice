import { useEffect } from 'react';
import type { RefObject } from 'react';
import type { Terminal } from '@xterm/xterm';
import { useSyncedRef } from '../../hooks/useSyncedRef';
import type { TerminalStatus } from '../../terminal/terminalTypes';
import {
  MAX_RECONNECT_ATTEMPTS,
  RECONNECT_STABLE_MS,
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
    let cancelled = false;
    let attempt = 0;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    // Armed on every open; fires only if the socket survives RECONNECT_STABLE_MS,
    // and ONLY then resets the backoff. Cleared on close so an accept-then-
    // immediate-close never reaches it. This — not `attempt = 0` in onopen — is
    // what keeps a flapping backend backing off instead of spinning a ~250ms
    // reconnect loop (and re-spawning a serverless pty each iteration). Mirrors
    // the stability timer in api/ws.ts's subscribeWs.
    let stableTimer: ReturnType<typeof setTimeout> | null = null;
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

    const clearStableTimer = () => {
      if (stableTimer) {
        clearTimeout(stableTimer);
        stableTimer = null;
      }
    };

    function connect() {
      if (cancelled || terminated) return;
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
        // Don't reset the backoff yet — a backend can complete the upgrade and
        // then immediately drop. Arm a timer that zeroes `attempt` only once the
        // socket has stayed open long enough to be healthy; the onclose clears it
        // so an accept-then-immediate-close never resets the counter. (Resetting
        // here was the bug: it pinned the backoff at the 250ms floor forever.)
        clearStableTimer();
        stableTimer = setTimeout(() => {
          attempt = 0;
          stableTimer = null;
        }, RECONNECT_STABLE_MS);
        if (reconnectingShown) {
          terminalNotices.reconnected(term);
          reconnectingShown = false;
        }
        reportStatus('live');
      };

      ws.onmessage = (ev) => {
        handleTerminalMessage(ev.data, {
          term,
          // Compare an incoming `attached` id against the LATEST captured id so
          // a re-attach to the same pty doesn't re-fire onServerId.
          serverId: serverIdRef.current,
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
        // Clear the pending stability timer first: a close before it fires means
        // the connection never proved healthy, so the backoff must keep growing.
        clearStableTimer();
        if (cancelled || terminated) return;
        // A terminal we can re-attach to (has a serverId, or captured one via
        // an earlier `attached` this session) reconnects to its EXISTING pty —
        // idempotent and safe to retry forever. So ride out a transient outage
        // (main-backend restart/stall, or a wedged upstream proxy under a heavy
        // "Run All" burst) with capped backoff instead of giving up and forcing
        // a manual page refresh. The genuine stop is `terminated`, set on a
        // clean `exit` or a `session_lost` — that is what bounds the deleted-
        // worktree runaway, not an attempt count.
        const canReattach = canReattachTerminal(serverIdRef.current, attachedOnce);
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
      clearStableTimer();
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
