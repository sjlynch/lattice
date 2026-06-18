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
  `mcpCustomServers`) and **`effectiveMcpServers(projectPath, harness)`** — the
  spawn-path resolver. Computes `enabled` per project (`mcpOverrides[id] ?? false`,
  `qaPlaywright` for playwright), folds in secrets, shapes the Claude config,
  filters by `harnessSupport`. Returns `{}` for non-claude harnesses (v1).
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

## Injection chokepoint

Injection happens at ONE place: the terminal-server's `POST /sessions` re-seed
(`terminalServer/routes.ts`), which calls
`ensureTrustedClaudeDir(cwd, { projectPath })` microseconds before `pty.spawn` —
after any `~/.claude.json` clobber by an exiting Claude. Every backend-spawned
Claude session funnels through there, so one wiring point covers all eight spawn
sites (incl. the QA-lane e2e run, which relies on this to get Playwright). Setup-time `ensureTrustedClaudeDir` calls stay trust-only (no
`projectPath`), so they never strip MCP a later call added. All Lattice-spawned
sessions use ephemeral cwds (worktrees / scratch), so the user's canonical
`projects[projectRoot]` entry is never written.

## Storage

- Definitions / overrides → `~/.lattice/globalSettings.json`
  (`mcpCustomServers`, `mcpBuiltinOverrides`) via `globalSettings.ts`.
- Per-project enables → `<project>/.lattice/userSettings.json` (`mcpOverrides`,
  `qaPlaywright`) via `userSettings.ts` — the backend reads these at spawn.
- Secrets → `~/.lattice/mcpSecrets.json` (`0600`), separate file, redaction is
  structural.

## Adding a built-in server

Add an entry to `BUILTIN_MCP_SERVERS` in `catalog.ts`. If it needs a key, set
`requiresSecret` (renders the masked field + status chip + get-a-key link) and,
if testable, add a `case` in `validators.ts`. Off by default automatically.
