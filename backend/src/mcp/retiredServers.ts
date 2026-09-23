// Catalog ids of built-in MCP servers that USED to ship and were removed
// (2026-09: `chrome-devtools` and `context7`). A leaf module with no imports so
// `userSettings/storage.ts` can use it without pulling the catalog in.
//
// Why it matters after removal: a project's per-harness toggle maps
// (`mcpOverrides`, `mcpHarnessOverrides`) may still hold `context7: true` from
// when it was a built-in. The resolver ignores a toggle whose id is not in the
// catalog — until the user imports (or adds) a CUSTOM server under that same
// id, at which point the stale `true` would silently switch it on in every
// agent. So:
//   - `userSettings/storage.ts` strips these ids from both toggle maps on read
//     (and on every incoming patch), and
//   - the importer (`importConfigs.ts`) renames an imported server that would
//     land on one of these ids, so an import can still be toggled normally.
export const RETIRED_BUILTIN_MCP_IDS: ReadonlySet<string> = new Set([
  'chrome-devtools',
  'context7',
]);
