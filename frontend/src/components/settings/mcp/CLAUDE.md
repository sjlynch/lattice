# frontend/src/components/settings/mcp

MCP-tab-only UI rendered by `settings/McpTab.tsx`.

- `McpServerRow` renders one catalog entry and delegates secret editing to
  `McpKeyField`.
- `McpKeyField` writes secrets immediately via `commitMcpSecret`; secrets never
  ride the Settings dialog Save button and never enter global/user settings.
- `McpAddCustom` edits machine-global custom-server definitions.
- `McpImportSection` scans/imports other tools' MCP configs; keep imported
  secrets redacted until explicitly saved through the secret API.
- Per-project enable toggles (`mcpOverrides`) are the only MCP-tab state saved
  with the dialog footer.
- Keep Playwright's global MCP toggle distinct from the QA-lane Playwright
  setting; see `backend/src/mcp/CLAUDE.md` for the split.
