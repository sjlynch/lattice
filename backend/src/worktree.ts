// Worktree subsystem barrel. Implementation lives in `worktree/`; this file
// keeps the existing `from './worktree.js'` import path stable for tests
// and call sites elsewhere in the backend.

export {
  setupTaskWorktree,
  ensureLatticeGitignore,
  ensureLatticeRepoExclude,
  untrackOwnedFilesInRepo,
  verifyEssentialExclusions,
  renderStopHookJson,
  type WorktreeResult,
} from './worktree/setup.js';

export {
  buildClaudeCommand,
  buildResumeCommand,
  buildPiCommand,
  buildPiResumeCommand,
  buildCodexCommand,
  buildCodexResumeCommand,
  buildConflictResolveCommand,
  buildStashResolveCommand,
} from './worktree/commands.js';

export {
  worktreeExists,
  isMidMerge,
  checkBranchExists,
  branchCommitCount,
  gitDirExists,
  assertGitDirIntact,
  parseWorktreesPorcelain,
  type ParsedWorktree,
} from './worktree/state.js';

// Narrowed-capability git wrapper for the project repo. Every git call
// whose cwd is the user's project root should go through `projectGit`.
export {
  projectGit,
  assertAllowedProjectGitArgs,
  DisallowedProjectGitError,
} from './worktree/projectGit.js';

export { backupProjectGitBundle } from './worktree/gitBackup.js';

export {
  writeMergeInstructions,
  writeStashResolveInstructions,
  writeRunStashResolveInstructions,
} from './worktree/instructions.js';

export {
  mergeWorktreeInRepo,
  fastForwardMain,
  type MergeOutcome,
  type MergeConflictKind,
} from './worktree/merge.js';

export {
  snapshotForRun,
  snapshotWorkingTree,
  restoreSnapshot,
  discardSnapshot,
  recoverPendingSnapshots,
  assertSafeForStash,
  RUN_STASH_LABEL,
  type SnapshotHandle,
} from './worktree/stash.js';

export {
  cleanupWorktreeForTask,
  assertNotReparsePoint,
  isUnderManagedWorktreesDir,
} from './worktree/cleanup.js';

export {
  finalizeMergedTask,
  type FinalizeOutcome,
} from './worktree/finalize.js';
