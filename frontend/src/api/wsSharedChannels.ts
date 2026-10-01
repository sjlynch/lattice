import { subscribeWs } from './wsTransport';
import type { WsSubscription } from './wsTransport';

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
