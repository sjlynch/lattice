// Per-project user settings — internal barrel.
//
// Implementation is split by concern:
//   - types.ts    — the UserSettings schema + StartupTerminal /
//                   TerminalDefaultHarness, with all the per-field commentary.
//   - storage.ts  — settings-file path/I/O (getUserSettings) + the patch-merge
//                   under the per-project serialize lock (patchUserSettings).
//   - features.ts — feature-specific accessors (Claude memory, QA terminal
//                   auto-close, post-merge hook enabled) layered on
//                   getUserSettings.
//
// The historical `../userSettings.js` shim re-exports this surface, so every
// consumer's import path and the public API stay unchanged.

export type {
  UserSettings,
  StartupTerminal,
  TerminalDefaultHarness,
} from './types.js';
export {
  getUserSettings,
  patchUserSettings,
  updateUserSettings,
  userSettingsShapeError,
} from './storage.js';
export {
  isClaudeMemoryDisabled,
  isQaTerminalAutoCloseEnabled,
  isKeepWorkflowStepTerminalsEnabled,
  isPostMergeHookEnabled,
  isCodexYoloEnabled,
  isTaskAgentsLatticeMcpOnly,
  taskAgentsLatticeMcpOnlyIn,
  isTaskAgentTypecheckEnabled,
  taskAgentTypecheckIn,
  getTaskWorktreeLfsContent,
  taskWorktreeLfsContentIn,
} from './features.js';
