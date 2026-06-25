# backend/src/terminalServerClient

The **backend-side HTTP client** for the detached terminal-server (its own
process on `:5185`; see `terminalServer/CLAUDE.md` for that boundary).
`../terminalServerClient.ts` is the re-export barrel — call sites
(`terminalProxy.ts`, `queuedCreateSession.ts`) import from
`'../terminalServerClient.js'`. Process spawn/respawn/health (`BASE`,
`ensureTerminalServer`) live separately in `../terminalServerLifecycle.ts`.

## Modules (split by intent, each with its own timeout)

- `sessions.ts` — the cheap best-effort probes: `proxyListSessions` /
  `proxyListSessionsOrNull` / `proxyCountSessions` / `proxyKillSession` /
  `proxyKillSessionsByCwd`, all on a shared **3s** timeout. Awaited on hot paths
  (spawn-queue accounting, recovery sweeps, worktree teardown) where a wedged
  terminal-server must surface as "can't tell" fast. The `…OrNull` variant
  returns `null` (not `[]`) when unreachable so callers that act on "no live
  sessions" can distinguish it from a real empty.
- `createSession.ts` — `POST /sessions` (`proxyCreateSession` /
  `tryCreateSessionOnce`), the heavy path, **30s** cap. Resolves the per-spawn
  Claude config (managed MCP set via `mcp/registry.ts` + memory opt-out) in the
  BACKEND and ships it as DATA in the `SessionWireBody`, so the terminal-server
  stays a dumb executor that never imports the resolver (see `mcp/CLAUDE.md`
  "Injection sites"). Handles a non-JSON reply by respawning + retrying once.
- `shutdown.ts` — `POST /shutdown` (`proxyShutdown`), **2s**, fired by the dev
  orchestrator on Ctrl+C (the detached server gets no signal of its own).

The three timeouts are intentionally separate — different intents.
