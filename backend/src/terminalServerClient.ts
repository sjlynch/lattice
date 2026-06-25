// Terminal-server client (proxy) — re-export barrel.
//
// The detached terminal-server runs as its own process on :5185 (see
// terminalServer/CLAUDE.md for that boundary). This is the BACKEND-side HTTP
// client for it, split by concern under ./terminalServerClient/:
//   - sessions.ts      — best-effort session probes/counting + kill (by id /
//                        by cwd) on the shared 3s probe timeout.
//   - createSession.ts — POST /sessions: per-spawn Claude config payload,
//                        non-JSON respawn-and-retry, response parsing, 30s cap.
//   - shutdown.ts      — POST /shutdown on the dev orchestrator's Ctrl+C.
//
// Every prior export is preserved here, so the call sites (terminalProxy.ts,
// queuedCreateSession.ts) are unchanged.

export {
  proxyCountSessions,
  proxyKillSession,
  proxyKillSessionsByCwd,
  proxyListSessions,
  proxyListSessionsOrNull,
} from './terminalServerClient/sessions.js';
export {
  proxyCreateSession,
  tryCreateSessionOnce,
  type CreateSessionOptions,
  type CreateSessionResult,
  type SessionWireBody,
} from './terminalServerClient/createSession.js';
export { proxyShutdown } from './terminalServerClient/shutdown.js';
