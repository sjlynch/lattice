# backend/src/mcp/import

"Import from existing tools": read the user's OTHER agent configs, normalize the
MCP servers they already declare into Lattice's `McpServerEntry` shape, and
classify their secrets. The orchestrator (`scanImportableServers` / `applyImport`
+ dedupe) and the public re-exports live in `../importConfigs.ts`; this directory
holds the concerns it composes. See `../CLAUDE.md` for the full secret-handling
policy (MCP plan §8) — don't duplicate it here.

## Modules

- `normalize.ts` — `normalizeServer` + the secret-classification helpers and the
  `Normalized` / `RawServer` types. **Security-relevant**: a LITERAL secret-looking
  env value (by var NAME *or* VALUE SHAPE — token prefixes, credentialed DSNs,
  high-entropy opaque tokens) is captured for `~/.lattice/mcpSecrets.json` and
  kept OFF the entry; a REFERENCE (`${input:…}`/`${env:…}`/`$VAR`/Codex
  `bearer_token_env_var`) is recorded as a `secretEnvVars` name with no value.
  Biases toward "secret" so nothing leaks into the world-readable settings file.
- `codexToml.ts` — `parseCodexMcpServers`: a minimal hand-rolled reader for
  Codex's `[mcp_servers.*]` TOML tables only (no TOML dep added; best-effort).
- `sources.ts` — the five per-tool `collect*` readers (Claude Code, Cursor,
  Codex, VS Code, Windsurf) + the `readJson` / `serversFromMap` helpers. All
  read-only; a missing/unparseable file is silently skipped.

`normalize.ts` and `codexToml.ts` are test-pinned via the `../importConfigs.js`
re-export path (`__tests__/mcp.test.ts`).
