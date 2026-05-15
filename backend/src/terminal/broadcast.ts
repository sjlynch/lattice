import type { WebSocket } from 'ws';

export function broadcastToSubscribers(subscribers: Set<WebSocket>, data: string): void {
  for (const ws of subscribers) {
    if (ws.readyState !== ws.OPEN) continue;
    try {
      ws.send(data);
    } catch {
      /* ignore */
    }
  }
}
