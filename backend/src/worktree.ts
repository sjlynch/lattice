// Worktree subsystem barrel. Implementation lives in `worktree/`; this file
// keeps the existing `from './worktree.js'` import path stable for tests
// and call sites elsewhere in the backend.

export {
  setupTaskWorktree,
  parseWorktreesPorcelain,
  ensureLatticeGitignore,
  ensureLatticeRepoExclude,
  untrackOwnedFilesInRepo,
  verifyEssentialExclusions,
  renderStopHookJson,
  type WorktreeResult,
  type ParsedWorktree,
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
} from './worktree/state.js';

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
  stashForRun,
  popStashByMessage,
  autoStashMessage,
  assertSafeForStash,
  RUN_STASH_LABEL,
} from './worktree/stash.js';

export { cleanupWorktreeForTask } from './worktree/cleanup.js';

export {
  finalizeMergedTask,
  type FinalizeOutcome,
} from './worktree/finalize.js';
