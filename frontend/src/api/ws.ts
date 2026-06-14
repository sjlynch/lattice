// Auto-reconnecting WebSocket subscription helper. Used by every live
// channel (tasks, merge-runs, workflows, workflow-runs).
//
// Behavior:
//   - Connects with exponential backoff capped at 5 s, so the subscription
//     survives backend restarts and the brief boot window when the proxy
//     responds ECONNREFUSED.
//   - Each new connection is treated as a fresh sync; the server is
//     expected to resend the relevant snapshot on connect.
//   - The returned function tears down both the timer and any open socket.

export type WsSubscription<T> = (event: T) => void;

export function subscribeWs<T>(
  pathWithQuery: string,
  onMessage: WsSubscription<T>,
): () => void {
  let ws: WebSocket | null = null;
  let cancelled = false;
  let attempt = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;

  function connect() {
    if (cancelled) return;
    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${window.location.host}${pathWithQuery}`);
    ws.onopen = () => {
      attempt = 0;
    };
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data) as T;
        onMessage(msg);
      } catch {
        /* ignore malformed frames */
      }
    };
    ws.onerror = () => {
      /* onclose will reschedule */
    };
    ws.onclose = () => {
      if (cancelled) return;
      const delay = Math.min(5000, 250 * 2 ** attempt);
      attempt += 1;
      timer = setTimeout(connect, delay);
    };
  }

  connect();
  return () => {
    cancelled = true;
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
// own connect. Pass the SAME predicate from every caller of a given path.
type SharedChannel<T> = {
  handlers: Set<WsSubscription<T>>;
  teardown: () => void;
  shouldReplay?: (msg: T) => boolean;
  lastReplay: T | undefined;
};

const sharedChannels = new Map<string, SharedChannel<unknown>>();

export function subscribeWsShared<T>(
  pathWithQuery: string,
  onMessage: WsSubscription<T>,
  shouldReplay?: (msg: T) => boolean,
): () => void {
  let channel = sharedChannels.get(pathWithQuery) as
    | SharedChannel<T>
    | undefined;
  if (!channel) {
    const created: SharedChannel<T> = {
      handlers: new Set(),
      teardown: () => {},
      shouldReplay,
      lastReplay: undefined,
    };
    created.teardown = subscribeWs<T>(pathWithQuery, (msg) => {
      if (created.shouldReplay?.(msg)) created.lastReplay = msg;
      // Snapshot the handler set so a handler that unsubscribes mid-dispatch
      // doesn't perturb the live iteration.
      for (const h of [...created.handlers]) h(msg);
    });
    channel = created;
    sharedChannels.set(pathWithQuery, created as SharedChannel<unknown>);
  }

  channel.handlers.add(onMessage);
  // Replay the latest cached snapshot to this (possibly late) joiner. No-op for
  // the first subscriber, which hasn't seen a snapshot yet and instead receives
  // it via the normal fan-out when the socket connects.
  if (channel.lastReplay !== undefined) onMessage(channel.lastReplay);

  let unsubscribed = false;
  return () => {
    if (unsubscribed) return;
    unsubscribed = true;
    const ch = sharedChannels.get(pathWithQuery) as
      | SharedChannel<T>
      | undefined;
    if (!ch) return;
    ch.handlers.delete(onMessage);
    if (ch.handlers.size === 0) {
      ch.teardown();
      sharedChannels.delete(pathWithQuery);
    }
  };
}
