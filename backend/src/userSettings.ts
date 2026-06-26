// Per-project user settings — re-export barrel.
//
// The implementation is split by concern under ./userSettings/:
//   - types.ts    — the UserSettings schema + StartupTerminal /
//                   TerminalDefaultHarness type definitions.
//   - storage.ts  — settings-file path/I/O + patch-merge under the per-project
//                   serialize lock (getUserSettings / patchUserSettings).
//   - features.ts — feature accessors (isClaudeMemoryDisabled,
//                   isQaTerminalAutoCloseEnabled).
//
// This barrel keeps the historical `./userSettings.js` import path working for
// every consumer (mcp/registry, terminal-server, routes/settings, the QA-run
// route, the test, …) — the public surface is unchanged. Note storage.ts pulls
// PROJECT_DIR_NAME from taskCache/paths.js (the leaf) rather than tasks.js, so
// userSettings stays free of the heavy taskCache import chain.

export * from './userSettings/index.js';
