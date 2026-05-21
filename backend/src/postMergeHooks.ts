// Post-merge hook public facade. Implementation is split under
// `postMergeHooks/`: registry/state, scratch paths, instruction rendering,
// Stop-hook / Pi-extension installer, command builder, and the trigger
// orchestrator.
//
// A post-merge hook is an optional per-project Lattice extension: whenever
// the user merges (per-task /merge or "Merge All"), Lattice spawns the
// configured harness in the project root with the user's prompt as its task,
// and the merge isn't considered complete until the harness calls back. This
// keeps any workflow merge step (or per-task merge response) gated on the
// post-merge agent finishing.

export type {
  PostMergeHookRun,
  PostMergeHookSession,
  PostMergeHookStatus,
} from './postMergeHooks/types.js';
export type { PostMergeHookEvent } from './postMergeHooks/registry.js';
export {
  finishPostMergeHook,
  getActiveHookForProject,
  getMostRecentHookForProject,
  getPostMergeHook,
  subscribePostMergeHooks,
  waitForPostMergeHook,
} from './postMergeHooks/registry.js';
export {
  runPostMergeHookGate,
  triggerPostMergeHook,
  type TriggerPostMergeHookOptions,
  type TriggerPostMergeHookOutcome,
} from './postMergeHooks/session.js';
