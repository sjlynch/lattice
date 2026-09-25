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
  `proxyKillSessionsByCwd`. The three hot-path variants (`…OrNull`, `Count`,
  `KillSessionsByCwd`) carry a shared **3s** `AbortSignal.timeout` — awaited on
  spawn-queue accounting, recovery sweeps, and worktree teardown, where a wedged
  terminal-server must surface as "can't tell" fast; `proxyListSessions` /
  `proxyKillSession` use the same timeout (return `[]` / `false` on any error). The
  `…OrNull` / `Count` variants return `null` (not `[]` / `0`) when unreachable so
  callers that act on "no live sessions" can distinguish it from a real empty.
  `proxyListSessionsShared` is a ≤750 ms memoized + single-flighted
  `…OrNull` for pollers that all want the same snapshot (the terminal-activity
  poller); the registry watch must NOT use it (a pre-spawn snapshot reports a
  new pty missing). `resetSessionsSnapshot` clears that memo (test seam).
- `createSession.ts` — `POST /sessions` (`proxyCreateSession` /
  `tryCreateSessionOnce`), the heavy path, **30s** cap. `resolveHarnessSpawnBody`
  resolves the per-harness spawn config (Claude/Codex managed MCP via
  `mcp/registry.ts` + memory opt-out + system-prompt overrides; Pi writes its
  cwd-local files) in the BACKEND and ships it as DATA in the `SessionWireBody`,
  so the terminal-server stays a dumb executor that never imports the resolver
  (see `mcp/CLAUDE.md` "Injection sites"). A socket error, timeout or malformed
  response retries once only if the same executor advertises deduplicated
  session creation; it reuses the exact request ID/body, pinned to that instance.
  Each attempt has a 30s cap (at most two attempts). Legacy/changed/unavailable
  executors receive no ambiguous replay, and failures never restart peer PTYs.
  The error reports when allocation remains uncertain. Codex commands also get
  the per-launch status-title default (`../codexTerminalActivity.ts`) here,
  before allocation, so new launches on retained executors receive it too.
  Serverless WS creation applies the same helper in `../terminalWsRelay.ts`.
  Both paths also regenerate the project's `.lattice/LATTICE_API*.md`
  (`refreshLatticeApiDocs`) before the pty exists — the terminal-server only
  looks the doc up for its banner, so API-doc edits never make it stale.
- `shutdown.ts` — `POST /shutdown` (`proxyShutdown`), **2s**, fired by the dev
  orchestrator on Ctrl+C (the detached server gets no signal of its own).

The three timeouts are intentionally separate — different intents.
