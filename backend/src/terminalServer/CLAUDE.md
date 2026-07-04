# backend/src/terminalServer

The **detached terminal-server** that runs as its own process on `:5185`,
separate from the main backend (`:5184`). PTY sessions — and the Claude/Pi/codex
agents inside them — live here so a main-server restart (`tsc -w`, a dev
restart, a crash) never kills a running agent. The main server reconnects on its
next boot.

`terminal-server.ts` (one level up) is the detached **entry point**; this folder
holds its pieces. The agent-facing PTY machinery itself lives in `../terminal/`
(re-exported via `../terminal.ts`); this folder is just the process's HTTP/WS/
lifecycle shell.

## The boundary

The terminal-server is a **dumb executor**. It never resolves spawn policy
(MCP servers, trust, memory opt-out) — the main backend does that and ships the
result as DATA in the `POST /sessions` body, which `createSessionHandler.ts`
applies verbatim microseconds before `pty.spawn` (`applyClaudeProjectConfig`).
Keeping resolution out of this long-lived process is deliberate: a spawn-policy
change is then a backend-only edit that never forces an agent-killing respawn of
this server.

The two sides of the wire:

- **Client side (main backend):** `../terminalServerClient.ts` (a barrel over
  `../terminalServerClient/`) is the HTTP client — `proxyCreateSession`,
  `proxyListSessions`/`Count`/`…OrNull`, `proxyKillSession[sByCwd]`,
  `proxyShutdown`. `../terminalServerLifecycle.ts` owns spawn/respawn/health
  (`BASE`, `ensureTerminalServer`) and the fingerprint check.
- **Server side (this folder):** the routes that serve those calls.

Anything new this process loads at runtime must be added to
`../terminalFingerprint.ts`'s `FINGERPRINT_FILES`, so a byte change makes a stale
orphan look different from a freshly-spawned server and get respawned. No manual
version constant.

## Layout

- `processGuards.ts` — `installTerminalProcessGuards()`: swallow node-pty's known
  Windows cleanup throw; every other uncaught exception/rejection is logged and
  then fails fast (exit 1) rather than leaving this detached process running in
  an undefined state (the main backend respawns it on demand). Installed first,
  before any PTY can throw asynchronously. Fail-fast contract regression-covered
  by `../__tests__/processGuards.test.ts`.
- `routes.ts` — `registerTerminalRoutes(app, { fingerprint, shutdown, authToken })`:
  the JSON HTTP surface — `GET /health` (returns the fingerprint), protected
  `GET /sessions`, `POST /sessions`, `DELETE /sessions/by-cwd` (**must** precede
  `/:id` — Express matches in registration order), `DELETE /sessions/:id`, and
  `POST /shutdown`. Protected routes reject disallowed browser `Origin`s and
  require the shared terminal-server token header. A catch-all 404 + error
  middleware force a **JSON-only** body so the client's `await res.json()` never
  explodes on stray HTML.
- `createSessionHandler.ts` — `POST /sessions` implementation: pre-create a pty;
  applies the backend-resolved Claude config, returns `{ id }`, or
  `503 {code:'CAP'}` at the hard cap.
- `websocket.ts` — the `/ws/terminal` upgrade handler: parse the query
  (`id`/`cwd`/`cols`/`rows`/`initialCommand`/`projectPath`) and hand the socket to
  `attachTerminal`. Non-matching upgrade paths are destroyed.
- `shutdown.ts` — `createTerminalShutdown()` (idempotent: kill every session, wait
  ~500 ms for `taskkill /T` to walk the tree, then `process.exit(0)`) +
  `wireTerminalShutdownSignals` (SIGTERM/SIGINT).
- `parentWatch.ts` — `watchParentProcess(parentPid, onGone)`: poll
  `BACKEND_PARENT_PID` (the long-lived orchestrator's pid, stable across dev
  restarts) and self-terminate if it disappears, so an ungracefully-killed
  backend doesn't leave this detached process orphaned on the box.

## Why detached / why no `&` kill

Because it's detached + unref'd, this process does **not** see the dev
orchestrator's Ctrl+C — that's exactly what `POST /shutdown` (client:
`proxyShutdown`, called by `scripts/dev.mjs`) and the `parentWatch` fallback are
for. Don't "fix" the detachment; it's what keeps agents alive across restarts.
