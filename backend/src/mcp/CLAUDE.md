# backend/src/mcp

The MCP (Model Context Protocol) control plane. Lattice is the single place a
user curates/toggles MCP servers; Lattice injects the enabled set into every
Claude session it spawns, instead of each harness carrying its own MCP config.

See `plans/mcp-integration.md` (gitignored) for the full design + decisions.

## Modules

- `catalog.ts` — the built-in server catalog **in code** (4 servers: playwright,
  chrome-devtools, context7, brave-search) + the `McpServerEntry` type. Package
  names live here so churn is a code change, not a data migration. **Invariant:
  there is no `enabledByDefault` flag** — everything is off until the resolver is
  told otherwise, so a new project loads nothing.
- `registry.ts` — `mergedCatalog()` (built-ins ⊕ `mcpBuiltinOverrides` ⊕
  `mcpCustomServers`) and **`effectiveMcpServers(projectPath, harness, ctx?)`** —
  the spawn-path resolver. Computes `enabled` per project (`mcpOverrides[id] ?? false`),
  folds in secrets, shapes the Claude config, filters by `harnessSupport`. Returns
  `{}` for non-claude harnesses (v1). **Playwright has two scopes** (`resolvePlaywright`):
  `mcpOverrides.playwright` is the GLOBAL toggle (any Lattice session + the
  project-root reconcile, always headless); `qaPlaywright` is QA-runs-ONLY and
  only applies when `ctx.isQaRun` (its `headless` flag is the QA lane's eye switch,
  and on a QA run it wins over the global toggle). `ctx.isQaRun` is set by the
  QA-run spawn alone; every other spawn leaves it false.
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
  secret-looking env values → stored in the secrets file + kept off the entry;
  references (`${input:…}`, Codex `bearer_token_env_var`) → recorded as
  `secretEnvVars` with no value (ambient inheritance). `parseCodexMcpServers` is a
  minimal `[mcp_servers.*]`-only TOML reader (no dep added).

## Injection sites

The PRIMARY (per-spawn) injection is at ONE place: the terminal-server's
`POST /sessions` re-seed (`terminalServer/routes.ts`), which calls
`ensureTrustedClaudeDir(cwd, { projectPath, isQaRun })` microseconds before
`pty.spawn` — after any `~/.claude.json` clobber by an exiting Claude. Every
backend-spawned Claude session funnels through there, so one wiring point covers
all eight spawn sites. The QA-run spawn passes `isQaRun: true` (its
`CreateSessionOptions` carries it into the POST body) so the QA-scoped Playwright
resolves; every other spawn leaves it false. Most Lattice spawns use ephemeral
cwds (worktrees / scratch), so they write throw-away `projects[<cwd>]` entries.

A SECOND, persistent injection is the **project-root reconcile**: `POST
/api/project-instrumentation` (`routes/projectClaude.ts`, fired on project open +
settings save) calls `ensureTrustedClaudeDir(<projectRoot>, { projectPath })` —
the one place Lattice intentionally writes the user's canonical
`projects[projectRoot].mcpServers`, so the GLOBAL servers (`mcpOverrides`, incl.
the Playwright global toggle) show up in a `claude` the user starts themselves at
the project root, and in Lattice sidebar terminals (cwd = project root). `isQaRun`
is left false there, so the QA-only Playwright never lands in the root entry.
Claude keys config by launch cwd, so this covers sessions started AT the project
root, not from a subdirectory. `reconcileMcpServers` only manages Lattice's own
servers (the `__latticeManagedMcp` marker), so the user's hand-added MCP entries
are never touched and turning a global toggle off strips it back out.

Setup-time `ensureTrustedClaudeDir` calls (worktree/scratch creation) stay
trust-only (no `projectPath`), so they never strip MCP a later call added.

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
