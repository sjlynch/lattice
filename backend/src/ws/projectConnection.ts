import type { WebSocket } from 'ws';
import {
  MAX_INITIAL_SNAPSHOT_LOADS,
  PROJECT_WS_HIGH_WATER_BYTES,
  PROJECT_WS_MAX_PENDING_EVENTS,
  PROJECT_WS_MAX_PENDING_BYTES,
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
  let loading = options.initial !== undefined;
  let dirty = false;
  let lastSnapshotEvent: { event: TEvent; bytes: number } | null = null;
  const pending: TEvent[] = [];
  let pendingBytes = 0;

  const cleanup = (): void => {
    if (closed) return;
    closed = true;
    loading = false;
    dirty = false;
    pending.length = 0;
    pendingBytes = 0;
    lastSnapshotEvent = null;
    // Release references and detach ownership before invoking user cleanup,
    // which may itself trigger close or a final subscription callback.
    const unsubscribe = unsub;
    unsub = null;
    unsubscribe?.();
  };
  ws.on('close', cleanup);

  const closeConnection = (): void => {
    if (closed) return;
    try {
      cleanup();
    } finally {
      ws.close();
    }
  };

  const terminateSlowClient = (reason: string): void => {
    if (closed) return;
    console.warn(
      `[ws] dropping slow client for ${project}: ${reason}; ` +
        'it will reconnect for a fresh snapshot',
    );
    try {
      cleanup();
    } finally {
      try {
        ws.terminate();
      } catch {
        /* ignore */
      }
    }
  };

  const forward = (event: TEvent): void => {
    if (closed || ws.readyState !== ws.OPEN) return;
    if (ws.bufferedAmount > PROJECT_WS_HIGH_WATER_BYTES) {
      terminateSlowClient(
        `${ws.bufferedAmount} bytes unsent (> ${PROJECT_WS_HIGH_WATER_BYTES})`,
      );
      return;
    }
    ws.send(serialize(event));
  };

  // Connect handshake: SUBSCRIBE FIRST, then load the initial snapshot.
  // Loading first lost events fired during the await. While `loading`, full
  // snapshots mark the load `dirty` (→ re-load), deltas queue in `pending`.
  // Nothing is sent before the snapshot, and a snapshot event is never sent
  // after a newer loaded snapshot.
  const onEvent = (event: TEvent): void => {
    if (closed || ws.readyState !== ws.OPEN) return;
    if (options.projectFromEvent && options.projectFromEvent(event) !== project) {
      return;
    }
    if (loading) {
      const snapshot = options.isSnapshotEvent?.(event) ?? false;
      const nextCount = pending.length + 1 + (!snapshot && lastSnapshotEvent ? 1 : 0);
      if (nextCount > PROJECT_WS_MAX_PENDING_EVENTS) {
        terminateSlowClient(
          `${nextCount} handshake events (> ${PROJECT_WS_MAX_PENDING_EVENTS})`,
        );
        return;
      }
      // Reuse the endpoint's per-WSS serializer/cache, including payload
      // mapping. Retain events, not a second connection-local string cache.
      const bytes = Buffer.byteLength(serialize(event), 'utf8');
      const nextBytes = pendingBytes - (snapshot ? lastSnapshotEvent?.bytes ?? 0 : 0) + bytes;
      if (nextBytes > PROJECT_WS_MAX_PENDING_BYTES) {
        terminateSlowClient(
          `${nextBytes} handshake bytes (> ${PROJECT_WS_MAX_PENDING_BYTES})`,
        );
        return;
      }
      pendingBytes = nextBytes;
      if (snapshot) {
        dirty = true;
        lastSnapshotEvent = { event, bytes };
      } else {
        pending.push(event);
      }
      return;
    }
    forward(event);
  };

  const drainPendingEvents = (): void => {
    // Do not copy the queue: cleanup must also release it if a send terminates
    // or closes the socket partway through this synchronous drain.
    for (let index = 0; index < pending.length; index++) forward(pending[index]!);
    pending.length = 0;
    pendingBytes = 0;
  };

  const settleInitialLoad = (payload: unknown, loaded: boolean): void => {
    if (closed || ws.readyState !== ws.OPEN) return;
    loading = false;
    if (loaded) {
      if (payload !== undefined) sendJson(ws, payload);
    } else if (lastSnapshotEvent) {
      // No snapshot could be loaded ('ignore'), so nothing newer is on the
      // wire: the latest live snapshot is the best the client can get.
      forward(lastSnapshotEvent.event);
    }
    lastSnapshotEvent = null;
    pendingBytes = 0;
    drainPendingEvents();
  };

  const attachSubscription = async (): Promise<void> => {
    let nextUnsub: Unsubscribe;
    try {
      nextUnsub = await options.subscribe(onEvent, project);
    } catch {
      closeConnection();
      return;
    }
    if (closed || ws.readyState !== ws.OPEN) {
      cleanup();
      nextUnsub();
      return;
    }
    // From here cleanup owns teardown, including close/overflow mid-load.
    unsub = nextUnsub;
    if (!options.initial) return;

    // Keep subscription and load awaits in this one async function so the
    // handshake and its error cleanup do not gain extra promise turns.
    let payload: unknown;
    let loaded = false;
    for (let attempt = 0; attempt < MAX_INITIAL_SNAPSHOT_LOADS; attempt++) {
      dirty = false;
      if (lastSnapshotEvent) pendingBytes -= lastSnapshotEvent.bytes;
      lastSnapshotEvent = null;
      try {
        payload = await options.initial(project);
        loaded = true;
      } catch {
        if (closed || ws.readyState !== ws.OPEN) return;
        if (options.initialError !== 'ignore') {
          closeConnection();
          return;
        }
        // Keep the last good load (if any) rather than nothing.
        break;
      }
      if (closed || ws.readyState !== ws.OPEN) return;
      if (!dirty) break;
    }

    settleInitialLoad(payload, loaded);
  };

  attachSubscription().catch(() => {
    closeConnection();
  });
}
