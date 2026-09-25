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

// ---------------------------------------------------------------------------
// Backend connection health, derived from every `subscribeWs` socket. A socket
// is "down" from its first close until it opens again; torn-down subscriptions
// never count. During a backend restart every live channel drops together, so
// "any socket down" is the signal behind the navbar's "Backend restarting —
// reconnecting…" pill (`components/BackendConnectionIndicator.tsx`, which
// debounces it so a single blip never shows). Never gates behaviour.
const downSockets = new Set<object>();
const connectionListeners = new Set<(down: boolean) => void>();

function markSocketDown(token: object, down: boolean): void {
  const wasDown = downSockets.size > 0;
  if (down) downSockets.add(token);
  else downSockets.delete(token);
  const isDown = downSockets.size > 0;
  if (wasDown === isDown) return;
  for (const listener of [...connectionListeners]) {
    try { listener(isDown); } catch { /* isolate listeners */ }
  }
}

export function isBackendConnectionDown(): boolean {
  return downSockets.size > 0;
}

/** Notified with `true` when the first live channel drops, `false` once all are back. */
export function subscribeBackendConnection(listener: (down: boolean) => void): () => void {
  connectionListeners.add(listener);
  return () => {
    connectionListeners.delete(listener);
  };
}

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

// Ref-counted multiplexer over `subscribeWs`: at most ONE live socket per
// distinct `pathWithQuery`, shared by every caller. The frame is JSON.parsed
// once (inside the underlying `subscribeWs`) and fanned out to all registered
// handlers; the socket opens on the first subscriber and tears down only when
// the last unsubscribes. Reconnect/backoff is inherited from `subscribeWs`.
//
// `shouldReplay` (optional) marks messages whose most-recent value is cached
// and replayed synchronously to a handler that joins an ALREADY-OPEN socket —
// so a late subscriber still receives the latest snapshot, preserving the
// per-connection initial re-sync each independent socket used to get on its
// own connect. Pass the SAME predicate and resetReplayOnDisconnect policy
// from every caller of a given path; disconnect callbacks remain per subscriber.
type SharedSubscriber<T> = {
  onMessage: WsSubscription<T>;
  onDisconnect?: () => void;
};

type SharedChannel<T> = {
  subscribers: Set<SharedSubscriber<T>>;
  teardown: () => void;
  shouldReplay?: (msg: T) => boolean;
  lastReplay: T | undefined;
  resetReplayOnDisconnect: boolean;
};

// Ephemeral signals such as "agent is working" must become unknown on a lost
// connection. Other feeds keep their existing snapshot replay behavior.
export type SharedWsLifecycle = {
  onDisconnect?: () => void;
  resetReplayOnDisconnect?: boolean;
};

const sharedChannels = new Map<string, SharedChannel<unknown>>();

export function subscribeWsShared<T>(
  pathWithQuery: string,
  onMessage: WsSubscription<T>,
  shouldReplay?: (msg: T) => boolean,
  lifecycle: SharedWsLifecycle = {},
): () => void {
  let channel = sharedChannels.get(pathWithQuery) as
    | SharedChannel<T>
    | undefined;
  if (!channel) {
    const created: SharedChannel<T> = {
      subscribers: new Set(),
      teardown: () => {},
      shouldReplay,
      lastReplay: undefined,
      resetReplayOnDisconnect: lifecycle.resetReplayOnDisconnect ?? false,
    };
    created.teardown = subscribeWs<T>(pathWithQuery, (msg) => {
      if (created.shouldReplay?.(msg)) created.lastReplay = msg;
      // Snapshot the handler set so a handler that unsubscribes mid-dispatch
      // doesn't perturb the live iteration.
      for (const subscriber of [...created.subscribers]) {
        try { subscriber.onMessage(msg); } catch { /* isolate subscribers */ }
      }
    }, () => {
      if (created.resetReplayOnDisconnect) created.lastReplay = undefined;
      for (const subscriber of [...created.subscribers]) {
        try { subscriber.onDisconnect?.(); } catch { /* isolate subscribers */ }
      }
    });
    channel = created;
    sharedChannels.set(pathWithQuery, created as SharedChannel<unknown>);
  }

  // Each call owns a registration even if two callers pass the same callback.
  // Capture its channel so an old cleanup can never affect a replacement one.
  const subscribedChannel = channel;
  const subscriber: SharedSubscriber<T> = { onMessage, onDisconnect: lifecycle.onDisconnect };
  subscribedChannel.subscribers.add(subscriber);
  // Replay the latest cached snapshot to this (possibly late) joiner. No-op for
  // the first subscriber, which hasn't seen a snapshot yet and instead receives
  // it via the normal fan-out when the socket connects.
  if (subscribedChannel.lastReplay !== undefined) {
    try { onMessage(subscribedChannel.lastReplay); } catch { /* still return the cleanup */ }
  }

  let unsubscribed = false;
  return () => {
    if (unsubscribed) return;
    unsubscribed = true;
    subscribedChannel.subscribers.delete(subscriber);
    if (subscribedChannel.subscribers.size === 0) {
      subscribedChannel.teardown();
      if (sharedChannels.get(pathWithQuery) === subscribedChannel) {
        sharedChannels.delete(pathWithQuery);
      }
    }
  };
}
