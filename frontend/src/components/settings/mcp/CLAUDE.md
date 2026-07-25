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
- The per-harness enable toggles (`mcpOverrides` + `mcpHarnessOverrides`) and the
  Playwright headed switch (`mcpPlaywrightHeaded`) are the only MCP-tab state saved
  with the dialog footer, each with its own touched clobber-guard in `McpTab`.
- Keep Playwright's global MCP toggle distinct from the QA-lane Playwright
  setting; see `backend/src/mcp/CLAUDE.md` for the split.
- The Playwright row carries a cross-harness **"Show browser"** switch
  (`McpServerRow`'s `HeadedToggle` → `mcpPlaywrightHeaded`) that runs the browser
  headed for the sessions it's enabled in. It saves with the dialog footer like
  the enable toggles (its own `headedTouched` clobber-guard in `McpTab`), and is
  independent of the QA lane's own headed/headless eye switch.
