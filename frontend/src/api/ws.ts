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
      // Don't reset the backoff yet — wait for the connection to prove stable.
      clearStableTimer();
      stableTimer = setTimeout(() => {
        attempt = 0;
        stableTimer = null;
      }, WS_STABLE_MS);
    };
    socket.onmessage = (ev) => {
      if (cancelled || ws !== socket) return;
      try {
        const msg = JSON.parse(ev.data) as T;
        onMessage(msg);
      } catch {
        /* ignore malformed frames */
      }
    };
    socket.onerror = () => {
      /* onclose will reschedule */
    };
    socket.onclose = () => {
      if (cancelled || ws !== socket) return;
      ws = null;
      clearStableTimer();
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
