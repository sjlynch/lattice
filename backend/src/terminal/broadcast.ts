import type { WebSocket } from 'ws';

// A browser that stops reading (a background tab the OS throttled, a laptop
// lid closed mid-stream, a wedged renderer) makes `ws.send` queue in memory —
// and this process hosts EVERY pty, so one stalled client could grow the
// executor's heap until an OOM took every agent down with it. Past this much
// unsent output the subscriber is dropped instead: its 'close' handler removes
// it, the frontend's reconnect logic re-attaches, and the disk-backed
// scrollback replay covers what was in flight.
export const SUBSCRIBER_HIGH_WATER_BYTES = 8 * 1024 * 1024;

// Frames held back for a subscriber whose replay is still being read from
// disk (see attachTerminal): they are delivered, in order, right after the
// replay frame, so a live frame can never land ahead of the history it
// follows. Keyed weakly so a socket that dies mid-replay leaks nothing.
const held = new WeakMap<WebSocket, { frames: string[]; bytes: number }>();

// Start queueing this subscriber's frames instead of sending them.
export function holdSubscriber(ws: WebSocket): void {
  held.set(ws, { frames: [], bytes: 0 });
}

// Stop queueing and hand back everything queued so far, in arrival order.
export function releaseSubscriber(ws: WebSocket): string[] {
  const entry = held.get(ws);
  held.delete(ws);
  return entry?.frames ?? [];
}

export function broadcastToSubscribers(subscribers: Set<WebSocket>, data: string): void {
  for (const ws of subscribers) {
    if (ws.readyState !== ws.OPEN) continue;
    const queue = held.get(ws);
    if (queue) {
      queue.frames.push(data);
      queue.bytes += data.length;
      // The same bound as below: a replay read that stalls must not let the
      // hold buffer become the unbounded queue it exists to prevent.
      if (queue.bytes > SUBSCRIBER_HIGH_WATER_BYTES) terminate(ws);
      continue;
    }
    if (ws.bufferedAmount > SUBSCRIBER_HIGH_WATER_BYTES) {
      terminate(ws);
      continue;
    }
    try {
      ws.send(data);
    } catch {
      /* ignore */
    }
  }
}

function terminate(ws: WebSocket): void {
  held.delete(ws);
  try {
    ws.terminate();
  } catch {
    /* ignore */
  }
}
