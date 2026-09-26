import type { WebSocket } from 'ws';
import {
  MAX_INITIAL_SNAPSHOT_LOADS,
  PROJECT_WS_HIGH_WATER_BYTES,
  type ProjectWsOptions,
  type Unsubscribe,
} from './projectEndpointContracts.js';

export function sendJson(ws: WebSocket, payload: unknown): void {
  if (ws.readyState !== ws.OPEN) return;
  ws.send(JSON.stringify(payload));
}

// Owns one validated project's socket. Serialization is supplied by the
// endpoint factory so its event cache stays shared across all connections.
export function handleProjectConnection<TEvent>(
  ws: WebSocket,
  project: string,
  options: ProjectWsOptions<TEvent>,
  serialize: (event: TEvent) => string,
): void {
  // ws v8 re-throws a socket 'error' as an uncaughtException when no listener
  // is registered. An abrupt client disconnect (ECONNRESET/EPIPE from a killed
  // tab, network partition, OS sleep, or a vite-proxy hard-drop) is routine,
  // not fatal — ignore so it can't masquerade as a backend crash. The 'close'
  // handler below still runs and tears down the subscription.
  ws.on('error', () => { /* routine client disconnect — ignore */ });

  let unsub: Unsubscribe | null = null;
  let closed = false;
  ws.on('close', () => {
    closed = true;
    if (unsub) {
      unsub();
      unsub = null;
    }
  });

  const forward = (event: TEvent): void => {
    if (ws.readyState !== ws.OPEN) return;
    if (ws.bufferedAmount > PROJECT_WS_HIGH_WATER_BYTES) {
      // terminate() moves readyState off OPEN at once, so this logs once
      // per connection; 'close' then tears the subscription down.
      console.warn(
        `[ws] dropping slow client for ${project}: ${ws.bufferedAmount} bytes unsent ` +
          `(> ${PROJECT_WS_HIGH_WATER_BYTES}); it will reconnect for a fresh snapshot`,
      );
      try {
        ws.terminate();
      } catch {
        /* ignore */
      }
      return;
    }
    ws.send(serialize(event));
  };

  // Connect handshake: SUBSCRIBE FIRST, then load the initial snapshot.
  // Loading first lost events fired during the await. While `loading`, full
  // snapshots mark the load `dirty` (→ re-load), deltas queue in `pending`.
  // Nothing is sent before the snapshot, and a snapshot event is never sent
  // after a newer loaded snapshot.
  let loading = options.initial !== undefined;
  let dirty = false;
  let lastSnapshotEvent: { event: TEvent } | null = null;
  const pending: TEvent[] = [];

  const onEvent = (event: TEvent): void => {
    if (options.projectFromEvent && options.projectFromEvent(event) !== project) {
      return;
    }
    if (loading) {
      if (options.isSnapshotEvent?.(event)) {
        dirty = true;
        lastSnapshotEvent = { event };
      } else {
        pending.push(event);
      }
      return;
    }
    forward(event);
  };

  const drainPendingEvents = (): void => {
    for (const event of pending.splice(0)) forward(event);
  };

  const settleInitialLoad = (payload: unknown, loaded: boolean): void => {
    loading = false;
    if (loaded) {
      if (payload !== undefined) sendJson(ws, payload);
    } else if (lastSnapshotEvent) {
      // No snapshot could be loaded ('ignore'), so nothing newer is on the
      // wire: the latest live snapshot is the best the client can get.
      forward(lastSnapshotEvent.event);
    }
    lastSnapshotEvent = null;
    drainPendingEvents();
  };

  const attachSubscription = async (): Promise<void> => {
    let nextUnsub: Unsubscribe;
    try {
      nextUnsub = await options.subscribe(onEvent, project);
    } catch {
      ws.close();
      return;
    }
    if (closed || ws.readyState !== ws.OPEN) {
      nextUnsub();
      return;
    }
    // From here the 'close' handler owns teardown, so a socket that closes
    // mid-load unsubscribes (no leaked listener).
    unsub = nextUnsub;
    if (!options.initial) return;

    // Keep subscription and load awaits in this one async function so the
    // handshake and its error cleanup do not gain extra promise turns.
    let payload: unknown;
    let loaded = false;
    for (let attempt = 0; attempt < MAX_INITIAL_SNAPSHOT_LOADS; attempt++) {
      dirty = false;
      lastSnapshotEvent = null;
      try {
        payload = await options.initial(project);
        loaded = true;
      } catch {
        if (options.initialError !== 'ignore') {
          ws.close();
          return;
        }
        // Keep the last good load (if any) rather than nothing.
        break;
      }
      if (closed) return;
      if (!dirty) break;
    }

    settleInitialLoad(payload, loaded);
  };

  attachSubscription().catch(() => {
    ws.close();
  });
}
