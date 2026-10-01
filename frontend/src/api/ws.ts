// Compatibility exports for WebSocket subscriptions and backend connection health.
// Resource lifetimes are owned by the modules below.
export {
  subscribeWs,
  wsReconnectDelay,
  WS_RECONNECT_BASE_MS,
  WS_RECONNECT_CAP_MS,
  WS_STABLE_MS,
} from './wsTransport';
export type { WsSubscription } from './wsTransport';
export { subscribeWsShared } from './wsSharedChannels';
export type { SharedWsLifecycle } from './wsSharedChannels';
export {
  isBackendConnectionDown,
  subscribeBackendConnection,
} from './wsConnectionHealth';
