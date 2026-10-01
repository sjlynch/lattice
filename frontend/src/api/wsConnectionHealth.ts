// ---------------------------------------------------------------------------
// Backend connection health, derived from every `subscribeWs` socket. A socket
// is "down" from its first close until it opens again; torn-down subscriptions
// never count. During a backend restart every live channel drops together, so
// "any socket down" is the signal behind the navbar's "Backend restarting —
// reconnecting…" pill (`components/BackendConnectionIndicator.tsx`, which
// debounces it so a single blip never shows). Never gates behaviour.
const downSockets = new Set<object>();
const connectionListeners = new Set<(down: boolean) => void>();

export function markSocketDown(token: object, down: boolean): void {
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
