// Manages the lifecycle of the terminal server (a separate process on port
// 5185) and proxies terminal WebSocket connections to it.
//
// Design rationale: PTY sessions are owned by terminal-server.ts, which runs
// detached from the main server. When the main server restarts (e.g. during
// development), the terminal server keeps running and all Claude agents inside
// it continue uninterrupted. The main server reconnects on next startup.

export { ensureTerminalServer } from './terminalServerLifecycle.js';
export {
  proxyCountSessions,
  proxyCreateSession,
  proxyKillSession,
  proxyKillSessionsByCwd,
  proxyListSessions,
  proxyShutdown,
} from './terminalServerClient.js';
export { proxyTerminalWs } from './terminalWsRelay.js';
