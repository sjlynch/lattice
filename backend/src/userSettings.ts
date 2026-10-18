// Per-project user settings (`<project>/.lattice/userSettings.json`) — the
// public facade over ./userSettings/. Implementation is split by concern:
//   - types.ts    — the UserSettings schema + StartupTerminal /
//                   TerminalDefaultHarness, with all the per-field commentary.
//   - storage.ts  — settings-file path/I/O (getUserSettings) + the patch-merge
//                   under the per-project serialize lock (patchUserSettings).
//   - features.ts — feature-specific accessors (Claude memory, QA terminal
//                   auto-close, post-merge hook enabled) layered on
//                   getUserSettings.

export type {
  UserSettings,
  StartupTerminal,
  TerminalDefaultHarness,
} from './userSettings/types.js';
export {
  getUserSettings,
  getUserSettingsStrict,
  patchUserSettings,
  updateUserSettings,
  userSettingsShapeError,
} from './userSettings/storage.js';
export {
  taskReviewIn,
  taskReviewerIn,
  isClaudeMemoryDisabled,
  isQaTerminalAutoCloseEnabled,
  isKeepWorkflowStepTerminalsEnabled,
  isPostMergeHookEnabled,
  isCodexYoloEnabled,
  isTaskAgentsLatticeMcpOnly,
  taskAgentsLatticeMcpOnlyIn,
  isTaskAgentTypecheckEnabled,
  taskAgentTypecheckIn,
  isTaskAgentTestsEnabled,
  taskAgentTestsIn,
  plannerSpecGapsIn,
  getTaskWorktreeLfsContent,
  taskWorktreeLfsContentIn,
} from './userSettings/features.js';
