// Shared renderer + installer for Pi's `.pi/extensions/lattice-complete.ts`
// completion backstop (worktree/stopHook.ts, postMergeHooks/stopHook.ts,
// workflowRuns/stepSpawner.ts, …), so every backstop gets the same hardening:
//   1. Configurable shutdown-reason gate: sites with a kill-by-cwd side effect
//      fire only on `reason === 'quit'` (so `/new`, `/reload`, `/fork` don't flip
//      a task); sites without one (workflow steps, post-merge hooks, security
//      reviews) accept any reason so abnormal exits still call back.
//   2. A short POST timeout so a wedged backend doesn't strand session_shutdown.
//   3. A small retry loop so a transient socket / DNS hiccup isn't fatal.
//   4. A sentinel file beside the extension (reason, attempts, outcome, error)
//      so "did it fire? did the POST succeed?" is visible on disk.
// New call-site = a `PiExtensionSite` value + a sentinel filename + the quit-gate
// choice, then `installPiCompletionExtension`. Don't inline a fresh copy.
//
// Stable public facade — callers import from `./piExtension.js`; keep exports
// stable. Internals: `piExtension/renderer.ts` (types, defaults, composition),
// `piExtension/template.ts` (generated TS), `piExtension/install.ts` (install +
// sentinel read).

export {
  type PiExtensionSite,
  type PiCompletionExtensionOptions,
  defaultPiSentinelFileName,
  defaultPiExtensionFileName,
  renderPiCompletionExtension,
} from './piExtension/renderer.js';

// Re-export the filesystem surface so existing callers keep importing
// everything from `./piExtension.js`.
export {
  installPiCompletionExtension,
  readPiShutdownSentinel,
} from './piExtension/install.js';
