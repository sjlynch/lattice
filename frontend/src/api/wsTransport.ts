import { markSocketDown } from './wsConnectionHealth';

// Auto-reconnecting WebSocket subscription helper. Used by every live
// channel (tasks, merge-runs, workflows, workflow-runs).
//
// Behavior:
//   - Connects with exponential backoff capped at 5 s, so the subscription
//     survives backend restarts and the brief boot window when the proxy
//     responds ECONNREFUSED.
//   - The backoff only resets once a connection has stayed open long enough
//     to be considered HEALTHY (>= WS_STABLE_MS). A server that accepts the
//     upgrade then immediately closes — a half-booted backend behind a proxy
//     that completes the handshake before it is ready — would otherwise reset
//     the attempt counter on every `onopen` and spin a tight ~250 ms reconnect
//     loop with no growing backoff, hammering the server during a restart.
//   - Each new connection is treated as a fresh sync; the server is
//     expected to resend the relevant snapshot on connect.
//   - The returned function tears down both timers and any open socket.

// Reconnect timing. Exported so the regression test can reason about the
// backoff curve and distinguish the stability timer from a reconnect timer.
export const WS_RECONNECT_BASE_MS = 250;
export const WS_RECONNECT_CAP_MS = 5000;
export const WS_STABLE_MS = 3000;

/** Exponential reconnect delay for a given (0-based) attempt, capped. */
export function wsReconnectDelay(attempt: number): number {
  return Math.min(WS_RECONNECT_CAP_MS, WS_RECONNECT_BASE_MS * 2 ** attempt);
}

export type WsSubscription<T> = (event: T) => void;

export function subscribeWs<T>(
  pathWithQuery: string,
  onMessage: WsSubscription<T>,
  onDisconnect?: () => void,
): () => void {
  let ws: WebSocket | null = null;
  let cancelled = false;
  let attempt = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  // Armed on every open, fires only if the socket survives WS_STABLE_MS. Its
  // firing — not `onopen` itself — is what proves the connection healthy and
  // resets the backoff. Cleared on close so an accept-then-immediate-close
  // never reaches it.
  let stableTimer: ReturnType<typeof setTimeout> | null = null;
  // Identity of this subscription in the connection-health set.
  const healthToken = {};

  function clearStableTimer() {
    if (stableTimer) {
      clearTimeout(stableTimer);
      stableTimer = null;
    }
  }

  function connect() {
    if (cancelled) return;
    timer = null;
    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const socket = new WebSocket(`${proto}://${window.location.host}${pathWithQuery}`);
    ws = socket;
    socket.onopen = () => {
      if (cancelled || ws !== socket) return;
      markSocketDown(healthToken, false);
      // Don't reset the backoff yet — wait for the connection to prove stable.
      clearStableTimer();
      stableTimer = setTimeout(() => {
        attempt = 0;
        stableTimer = null;
      }, WS_STABLE_MS);
    };
    socket.onmessage = (ev) => {
      if (cancelled || ws !== socket) return;
      let msg: T;
      try {
        msg = JSON.parse(ev.data) as T;
      } catch {
        /* ignore malformed frames */
        return;
      }
      // Dispatched OUTSIDE the parse guard: a consumer that threw used to be
      // swallowed by the same silent catch, so the failure never surfaced and
      // the UI quietly drifted from the stream. Report it — and never close
      // the socket over it; the next frame still gets delivered.
      try {
        onMessage(msg);
      } catch (err) {
        console.error('[ws] handler failed', pathWithQuery, err);
      }
    };
    socket.onerror = () => {
      /* onclose will reschedule */
    };
    socket.onclose = () => {
      if (cancelled || ws !== socket) return;
      ws = null;
      clearStableTimer();
      markSocketDown(healthToken, true);
      try {
        onDisconnect?.();
      } catch {
        /* a subscriber must not prevent reconnecting */
      }
      if (cancelled) return;
      const delay = wsReconnectDelay(attempt);
      attempt += 1;
      timer = setTimeout(connect, delay);
    };
  }

  connect();
  return () => {
    cancelled = true;
    markSocketDown(healthToken, false);
    clearStableTimer();
    if (timer) clearTimeout(timer);
    try {
      ws?.close();
    } catch {
      /* ignore */
    }
  };
}
