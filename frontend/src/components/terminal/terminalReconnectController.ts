import type { TerminalStatus } from '../../terminal/terminalTypes';
import {
  RECONNECT_STABLE_MS,
  canReattachTerminal,
  reconnectDelay,
  shouldGiveUpReconnect,
} from './terminalSocket';

export type ReconnectTimerHandle = ReturnType<typeof setTimeout>;

export type TerminalReconnectControllerCallbacks = {
  getServerId: () => string | undefined;
  reconnect: () => void;
  setTimer: (callback: () => void, delay: number) => ReconnectTimerHandle;
  clearTimer: (timer: ReconnectTimerHandle) => void;
  onStatus: (status: TerminalStatus, exitCode?: number) => void;
  onReconnected: () => void;
  onReconnecting: () => void;
  onGaveUp: () => void;
};

export type TerminalReconnectController = {
  startConnecting: () => void;
  canConnect: () => boolean;
  handleOpen: () => void;
  handleAttached: () => void;
  handleTerminated: (status: TerminalStatus, exitCode?: number) => void;
  handleClose: () => void;
  cancel: () => void;
};

export function createTerminalReconnectController(
  callbacks: TerminalReconnectControllerCallbacks,
): TerminalReconnectController {
  let cancelled = false;
  let attempt = 0;
  let retryTimer: ReconnectTimerHandle | null = null;
  // Armed on every open; fires only if the socket survives RECONNECT_STABLE_MS,
  // and ONLY then resets the backoff. Cleared on close so an accept-then-
  // immediate-close never reaches it. This — not `attempt = 0` in onopen — is
  // what keeps a flapping backend backing off instead of spinning a ~250ms
  // reconnect loop (and re-spawning a serverless pty each iteration). Mirrors
  // the stability timer in api/ws.ts's subscribeWs.
  let stableTimer: ReconnectTimerHandle | null = null;
  let reconnectingShown = false;
  // Once the pty has signalled it is gone (clean exit, or backend says
  // session_lost), stop reconnecting. Without this, every WS close — including
  // the one immediately following a clean pty exit — would trigger a fresh
  // connect, which on a deleted-worktree session produces a feedback loop that
  // spawns thousands of doomed ptys.
  let terminated = false;
  // True once this connection has received an `attached` frame — i.e. the
  // terminal-server owns a live pty that a reconnect just re-subscribes to
  // (idempotent). Lets a terminal that started life serverless still reconnect
  // indefinitely, since it captured a session id on first attach.
  let attachedOnce = false;

  const clearStableTimer = () => {
    if (stableTimer) {
      callbacks.clearTimer(stableTimer);
      stableTimer = null;
    }
  };

  const clearRetryTimer = () => {
    if (retryTimer) {
      callbacks.clearTimer(retryTimer);
      retryTimer = null;
    }
  };

  return {
    startConnecting() {
      callbacks.onStatus('connecting');
    },

    canConnect() {
      return !cancelled && !terminated;
    },

    handleOpen() {
      if (cancelled || terminated) return;
      // Don't reset the backoff yet — a backend can complete the upgrade and
      // then immediately drop. Arm a timer that zeroes `attempt` only once the
      // socket has stayed open long enough to be healthy; the onclose clears it
      // so an accept-then-immediate-close never resets the counter. (Resetting
      // here was the bug: it pinned the backoff at the 250ms floor forever.)
      clearStableTimer();
      stableTimer = callbacks.setTimer(() => {
        attempt = 0;
        stableTimer = null;
      }, RECONNECT_STABLE_MS);
      if (reconnectingShown) {
        callbacks.onReconnected();
        reconnectingShown = false;
      }
      callbacks.onStatus('live');
    },

    handleAttached() {
      attachedOnce = true;
    },

    handleTerminated(status, exitCode) {
      terminated = true;
      callbacks.onStatus(status, exitCode);
    },

    handleClose() {
      // Clear the pending stability timer first: a close before it fires means
      // the connection never proved healthy, so the backoff must keep growing.
      clearStableTimer();
      if (cancelled || terminated) return;
      // A terminal we can re-attach to (has a serverId, or captured one via an
      // earlier `attached` this session) reconnects to its EXISTING pty —
      // idempotent and safe to retry forever. So ride out a transient outage
      // (main-backend restart/stall, or a wedged upstream proxy under a heavy
      // "Run All" burst) with capped backoff instead of giving up and forcing
      // a manual page refresh. The genuine stop is `terminated`, set on a clean
      // `exit` or a `session_lost` — that is what bounds the deleted-worktree
      // runaway, not an attempt count.
      const canReattach = canReattachTerminal(
        callbacks.getServerId(),
        attachedOnce,
      );
      if (shouldGiveUpReconnect(canReattach, attempt)) {
        // Serverless terminal that never attached: a reconnect here can spawn a
        // fresh pty, so it must stay bounded.
        callbacks.onGaveUp();
        terminated = true;
        callbacks.onStatus('dead');
        return;
      }
      if (!reconnectingShown) {
        callbacks.onReconnecting();
        reconnectingShown = true;
        callbacks.onStatus('reconnecting');
      }
      const delay = reconnectDelay(attempt);
      attempt += 1;
      retryTimer = callbacks.setTimer(() => {
        retryTimer = null;
        callbacks.reconnect();
      }, delay);
    },

    cancel() {
      cancelled = true;
      clearRetryTimer();
      clearStableTimer();
    },
  };
}
