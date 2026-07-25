# backend/src/mcp

The MCP (Model Context Protocol) control plane. Lattice is the single place a
user curates/toggles MCP servers; Lattice injects the enabled set into the
Claude, Codex, and Pi sessions it spawns, instead of each harness carrying its
own MCP config.

See `plans/mcp-integration.md` + `plans/mcp-codex-pi-harness-plan.md` (both
gitignored) for the full design + decisions.

## Per-harness toggles (Claude / Codex / Pi)

Every catalog server can be enabled **independently per harness**. Claude keeps
the legacy `UserSettings.mcpOverrides` map (plus its QA-scoped Playwright);
Codex and Pi use the nested `UserSettings.mcpHarnessOverrides` (`{ codex?: {
[id]: boolean }, pi?: { [id]: boolean } }`). Everything is off by default;
enabling a server for one harness never loads it into another. The
`McpHarnessSupport {claude,codex,pi}` per-server capability flags gate which
harnesses can even offer a server.

The resolver core is harness-neutral: **`resolveMcpEntries(catalog, settings,
secrets, harness, ctx)`** applies the support filter + the per-harness toggle
(Claude's Playwright two-scope policy still runs only for Claude; Codex/Pi treat
Playwright as a plain toggle, no QA scope). Playwright is **headless by default**
for all three harnesses; the cross-harness `mcpPlaywrightHeaded` setting (the MCP
tab's "Show browser" switch) flips the non-QA path to headed — QA runs keep their
own `qaPlaywright.headless` eye switch, which `mcpPlaywrightHeaded` never
overrides. Three shapers map
its output into each harness's config: `resolveClaudeServers` (→ Claude
`mcpServers`), `resolveCodexServers` (→ `-c` inline-TOML overrides + secret env),
`resolvePiServers` (→ `.pi/mcp.json` server map + secret env).

### Codex mechanism (`codexServerConfig.ts`)
Per-invocation `-c "mcp_servers.<lattice_id>={…}"` inline-TOML overrides (value
parsed as TOML, dotted key MERGES so the user's own servers survive), mirroring
`terminal/codexTrust.ts`'s trust override — never writes `~/.codex/config.toml`.
Secrets ride the pty env by NAME: stdio → `env_vars=['VAR']`, HTTP header →
`env_http_headers={Header='VAR'}` (value in pty env, never argv). The backend
resolves the strings; the terminal-server turns each into a `--config` flag
referencing an env var (`configureCodexProjectMcp` in `terminal/codexTrust.ts`),
so braces/quotes never enter shell source.

### Pi mechanism (`piServerConfig.ts` + `../piMcp/`)
Pi has no native MCP, so Lattice loads the third-party **`pi-mcp-adapter`**
(official Pi `@earendil-works/pi-*` ≥0.74; private, Lattice-owned install under
`~/.lattice/pi-mcp-adapter/` — never the user's global Pi config, same pattern as
`piSubagents/`) and drops two cwd-local files into each Lattice-spawned Pi
session: `<cwd>/.pi/mcp.json` (the enabled server set, reconciled with a
`__latticeManagedMcp` marker so the user's own servers survive) +
`<cwd>/.pi/extensions/lattice-mcp.ts` (the loader shim Pi auto-discovers
cwd-exactly). The **backend** writes both at the spawn chokepoint (`piMcp.ts`
`applyPiMcpForSpawn`) — Pi's mechanism is cwd files, not wire data, so they must
exist before Pi starts. Each server carries `lifecycle: 'eager'` + `directTools:
true` (individual tools when the adapter's metadata cache is warm; a cold
worktree falls back to the always-present `mcp()` proxy tool — either way tools
are reachable). Pi ≥0.74 only reads cwd-local `.pi/extensions/` in a *trusted*
project, so Lattice spawns Pi with **`--approve`** (`agentCommandBuilder.ts`, the
Pi analogue of `--dangerously-skip-permissions` / `--yolo`) to trust the session
cwd for that run only (never persisted) — without it every cwd-extension shim
(MCP, pi-subagents, completion) is inert. Secret transport (stdio in pty env,
HTTP-header secrets as `${VAR}` refs) is in `piServerConfig.ts`. See `../piMcp/`.

### v1 coverage
Lattice-created launches only (task/resume, workflow step, prompt customization,
post-merge hook, sidebar harness launcher — all funnel through
`proxyCreateSession` → `resolveHarnessSpawnBody`). The sidebar launcher reaches
that chokepoint via **`POST /api/terminals`** (`routes/terminals.ts`), which
pre-creates the pty and hands the frontend a `serverId` to attach by — WITHOUT
it, a sidebar terminal connects serverlessly to `/ws/terminal` (the pty is built
straight from the WS query params), so Codex/Pi get no MCP and only Claude
survives via its persistent `~/.claude.json` reconcile. A harness typed into an
already-open plain shell is still not observable at the chokepoint, and Lattice
does not write a tracked `.codex/config.toml` / a proactive project-root
`.pi/mcp.json` just to cover it. (Startup-configured harness terminals also stay
serverless for now — see `frontend/src/components/sidebar/CLAUDE.md`.)

## Modules

- `catalog.ts` — the built-in server catalog **in code** (4 servers: playwright,
  chrome-devtools, context7, brave-search) + the `McpServerEntry` type. Package
  names live here so churn is a code change, not a data migration. **Invariant:
  there is no `enabledByDefault` flag** — everything is off until the resolver is
  told otherwise, so a new project loads nothing. **Playwright ships `--isolated`
  in its catalog args** (not optional): `@playwright/mcp` otherwise shares ONE
  persistent profile dir, so a second concurrent instance dies with "Browser is
  already in use" — and Lattice injects Playwright into many concurrent sessions.
  `--isolated` gives each its own throwaway in-memory profile. The three shapers
  append `--headless` on top of this when the resolved `headless` is true.
- `registry.ts` — the resolver **facade**: `mergedCatalog()` (built-ins ⊕
  `mcpBuiltinOverrides` ⊕ `mcpCustomServers`) and **`effectiveMcpServers(projectPath,
  harness, ctx?)`** — the spawn-path resolver — plus the pure orchestration core
  `resolveClaudeServers(catalog, settings, secrets, ctx)`. It owns the catalog
  merge + the per-entry loop (the `harnessSupport` filter and the per-server
  `mcpOverrides[id] ?? false` toggle gate); the per-decision logic is composed in
  from two focused pure helpers (below). Returns `{}` for non-claude harnesses
  (v1). The `McpResolveContext` type (only field: `ctx.isQaRun`, set by the QA-run
  spawn alone) lives here as part of the public surface.
- `settingsValidation.ts` / `overrideSecurity.ts` — defensive parsers for the
  UNTRUSTED `mcpCustomServers` / `mcpBuiltinOverrides` off `PATCH
  /api/global-settings`. `sanitizeCustomServers` / `sanitizeBuiltinOverrides` keep
  only resolver-read fields; `applyBuiltinOverride` (used by `mergedCatalog`)
  re-pins a built-in's id/command/url from the catalog and enforces
  **additive-only args** (an override can append a Playwright `--browser` flag but
  can't swap the package spec). `overrideSecurity.ts` is the env denylist
  (`sanitizeOverrideEnv`): an override's `env` can never set a code-exec /
  launcher-hijack var (`NODE_OPTIONS`, `LD_PRELOAD`, `PATH`, `npm_config_*`, …).
  **A built-in override may TUNE a server but never re-point what it runs.**
- `resolverPolicy.ts` — **MCP resolver policy** (pure, no I/O): `resolvePlaywright`.
  **Playwright has two scopes** — `mcpOverrides.playwright` is the GLOBAL toggle
  (any Lattice session + the project-root reconcile, headless unless
  `mcpPlaywrightHeaded` is on); `qaPlaywright` is QA-runs-ONLY and only applies
  when `isQaRun` (its `headless` flag is the QA lane's eye switch, and on a QA run
  it wins over the global toggle — `mcpPlaywrightHeaded` never touches a QA run).
- `claudeServerConfig.ts` — **Claude config shaping** (pure, no I/O):
  `secretEnvVarsFor(entry)` (secret-env selection: `requiresSecret.envVar` ⊕
  `secretEnvVars`) and `toClaudeConfig(entry, serverSecrets, headless)` (shape one
  entry into Claude's per-server config, fold in stored secrets — stdio env via
  `secretEnvVars`, HTTP headers via `secretHeaders` — / append the Playwright
  `--headless` flag / win32-wrap the command). Deliberately separate
  from `claudeInject.ts` so the resolver/secret logic stays out of the terminal-
  server's apply path + fingerprint (see "Injection sites").
- `codexServerConfig.ts` — **Codex config shaping** (pure, no I/O):
  `toCodexServerConfig(entry, secrets, headless)` → one `-c` inline-TOML override
  string (`mcp_servers.lattice_<id>={…}`) + the secret env for the pty.
  `safeCodexServerId` namespaces/underscores catalog ids. A JSON string is a
  valid TOML basic string (same trick as `codexTrust`), so `JSON.stringify` is
  the string/array renderer.
- `piServerConfig.ts` — **Pi config shaping** (pure, no I/O):
  `toPiServerConfig(entry, secrets, headless)` → one `pi-mcp-adapter` server
  config (for `.pi/mcp.json`) + the secret env for the pty. `lifecycle: 'eager'`
  + `directTools: true`; stdio secrets omitted from the file (inherited via
  process.env); HTTP secret headers written as `${VAR}` references (value in pty
  env, shared `secretHeaderEnvVar` naming with Codex). See `../piMcp/`.
- `secrets.ts` — read/write `~/.lattice/mcpSecrets.json` (`0600`), kept in its
  OWN file so the settings endpoints never touch secret bytes. `redactSecrets()`
  → presence booleans; `secretHints()` → `••••<last4>`. **Raw values never cross
  backend → browser.**
- `claudeInject.ts` — pure shaping: `reconcileMcpServers(entry, managed)` (add
  managed, strip previously-managed-now-disabled via the `__latticeManagedMcp`
  sibling marker, leave the user's own entries alone) + `platformizeCommand`
  (wrap `npx`/`uvx`/… in `cmd /c` on win32, since the MCP SDK spawns without a
  shell and a bare `npx` ENOENTs on Windows).
- `validators.ts` — per-server "is my key working?" probes behind
  `POST /api/mcp/validate` (v1: Brave one-search request only).
- `importConfigs.ts` — read-only scan of other tools' MCP configs (Claude Code,
  Cursor, Codex TOML, VS Code, Windsurf) → normalized `McpServerEntry[]`. Literal
  secret-looking **env AND HTTP-header** values → stored in the secrets file +
  kept off the entry (env keys recorded in `secretEnvVars`, header names in
  `secretHeaders`); references (`${input:…}`, Codex `bearer_token_env_var`) →
  recorded with no value (env: ambient inheritance; header: placeholder the user
  still supplies). `scanImportableServers` surfaces both lists in the preview.
  This file is now a thin orchestrator (`scanImportableServers`/`applyImport` +
  dedupe) that re-exports the public surface; the concerns live under `import/`:
  - `import/normalize.ts` — `normalizeServer` + the `Normalized`/`RawServer` types
    (shape assembly; test-pinned), consuming `import/secretDetection.ts` for the
    per-value classification. The same name/value secret classification runs over
    HTTP headers, not just stdio env, so an imported auth header's literal key
    never lands in globalSettings.json — it routes to the secrets file (keyed by
    header name) via `secretHeaders`, and `claudeServerConfig.toClaudeConfig`
    re-injects it at spawn.
  - `import/secretDetection.ts` — the security-relevant secret-classification core
    (`looksSecret`/`looksSecretValue`/`isReference` + regex/entropy internals),
    split out so the detection surface is auditable in isolation.
  - `import/codexToml.ts` — the minimal `[mcp_servers.*]`-only TOML reader
    (`parseCodexMcpServers`; no dep added; test-pinned).
  - `import/sources.ts` — the five per-tool `collect*` config readers plus the
    `readJson`/`serversFromMap` helpers.

## Injection sites — resolve in the backend, apply in the terminal-server

Policy is **resolved in the main backend** and **applied** (written to
`~/.claude.json`) by whoever spawns — split deliberately so the detached
terminal-server never imports the resolver. Why: the terminal-server is a
long-lived process whose runtime files are content-fingerprinted; if MCP policy
lived there, every policy edit would change a fingerprinted file and force a
respawn that **kills every running agent** (and the resolver could silently run
stale). Keeping policy in the backend makes a policy change a backend-only edit —
no respawn, never stale. The terminal-server stays a dumb executor.

The PRIMARY (per-spawn) path: the main backend's `proxyCreateSession`
(`terminalServerClient.ts`) calls `resolveManagedClaudeServers(projectPath, {isQaRun})`
+ `isClaudeMemoryDisabled(projectPath)` and folds the result into the `POST
/sessions` body (`SessionWireBody.managedMcpServers` / `disableClaudeMemory`).
The terminal-server's handler (`terminalServer/createSessionHandler.ts`) then
calls `applyClaudeProjectConfig(cwd, { managed })` microseconds before `pty.spawn` —
after any `~/.claude.json` clobber by an exiting Claude — writing the
backend-resolved set verbatim. Every backend-spawned Claude session funnels
through `proxyCreateSession`, so one wiring point covers all eight spawn sites.
The QA-run spawn passes `isQaRun: true` so the QA-scoped Playwright resolves;
every other spawn leaves it false. Most Lattice spawns use ephemeral cwds
(worktrees / scratch), so they write throw-away `projects[<cwd>]` entries.

A SECOND, persistent path is the **project-root reconcile**: `POST
/api/project-instrumentation` (`routes/projectClaude.ts`, fired on project open +
settings save) resolves with `resolveManagedClaudeServers(project, {isQaRun:false})`
and `applyClaudeProjectConfig(<projectRoot>, { managed })` — the one place Lattice
intentionally writes the user's canonical `projects[projectRoot].mcpServers`, so
the GLOBAL servers (`mcpOverrides`, incl. the Playwright global toggle) show up in
a `claude` the user starts themselves at the project root, and in Lattice sidebar
terminals (cwd = project root). `isQaRun` is false there, so the QA-only Playwright
never lands in the root entry. Claude keys config by launch cwd, so this covers
sessions started AT the project root, not from a subdirectory. `reconcileMcpServers`
only manages Lattice's own servers (the `__latticeManagedMcp` marker), so the
user's hand-added MCP entries are never touched and turning a global toggle off
strips it back out.

Setup-time `seedClaudeTrust(dir)` calls (worktree/scratch creation) are
trust-only (`managed: null`), so they never strip MCP a later call added.

`claudeTrust.ts` (the apply mechanism) imports only `claudeInject.ts` (no
resolver) and is in the terminal-server's fingerprint set — so a change to the
write mechanism itself still takes effect, while the policy modules
(`registry.ts`/`userSettings.ts`/…) stay out of the fingerprint and out of the
terminal-server entirely.

## Storage

- Definitions / overrides → `~/.lattice/globalSettings.json`
  (`mcpCustomServers`, `mcpBuiltinOverrides`) via `globalSettings.ts`.
- Per-project enables → `<project>/.lattice/userSettings.json` via `userSettings.ts`
  (read at spawn): `mcpOverrides` (per-server global toggles, incl.
  `mcpOverrides.playwright`) and `qaPlaywright` (the QA lane's separate
  QA-runs-only Playwright enable + headed/headless eye switch).
- Secrets → `~/.lattice/mcpSecrets.json` (`0600`), separate file, redaction is
  structural.

## Adding a built-in server

Add an entry to `BUILTIN_MCP_SERVERS` in `catalog.ts`. If it needs a key, set
`requiresSecret` (renders the masked field + status chip + get-a-key link) and,
if testable, add a `case` in `validators.ts`. Off by default automatically.
