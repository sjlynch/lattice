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
