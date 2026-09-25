# frontend/src/components/settings/mcp

MCP-tab-only UI rendered by `settings/McpTab.tsx`.

- `McpServerRow` renders one catalog entry with three independent per-harness
  enable toggles (Claude → `mcpOverrides`, Codex/Pi → `mcpHarnessOverrides`) and
  delegates secret editing to `McpKeyField`.
- `McpKeyField` writes secrets immediately via `commitMcpSecret` (its
  edit/commit/clear/test state machine lives in `useSecretField`); secrets never
  ride the Settings dialog Save button and never enter global/user settings.
- `McpAddCustom` edits machine-global custom-server definitions.
- `McpImportSection` scans/imports other tools' MCP configs; keep imported
  secrets redacted until explicitly saved through the secret API.
- `useMcpTabDraft` owns `McpTab`'s state: the load-on-open effect (strict
  settings load — `loaded` only flips on success), the reloaders, per-harness
  `isEnabledFor`/`toggle`, the Playwright-headed and lattice-only setters, and
  `getPatch()` (backs `McpTabHandle.getMcpUserPatch`). Also exports
  `PLAYWRIGHT_SERVER_ID`.
- `mcpSecretStatus` derives a row's key chip (`primaryEnvVar`, `hasSecret`,
  `secretHint`, `hasEnv`) from the redacted secrets / env presence.
- `mcpCustomServers` (`upsertCustomServer` / `removeCustomServer`) rewrites
  `globalSettings.mcpCustomServers` via one fetch → patch sequence.
- The per-harness enable toggles (`mcpOverrides` + `mcpHarnessOverrides`), the
  Playwright headed switch (`mcpPlaywrightHeaded`) and the lattice-only checkbox
  (`taskAgentsLatticeMcpOnly`) are the only MCP-tab state saved with the dialog
  footer, each with its own touched clobber-guard in `useMcpTabDraft`.
- Keep Playwright's global MCP toggle distinct from the QA-lane Playwright
  setting; see `backend/src/mcp/CLAUDE.md` for the split.
- The Playwright row carries a cross-harness **"Show browser"** switch
  (`McpServerRow`'s `HeadedToggle` → `mcpPlaywrightHeaded`) that runs the browser
  headed for the sessions it's enabled in. It saves with the dialog footer like
  the enable toggles (its own `headedTouched` clobber-guard in `useMcpTabDraft`), and is
  independent of the QA lane's own headed/headless eye switch.
