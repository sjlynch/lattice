// Shared renderer + installer for Pi's `.pi/extensions/lattice-complete.ts`
// completion backstop. Replaces the three near-identical inline renderers
// previously inlined in worktree/stopHook.ts, postMergeHooks/stopHook.ts,
// and workflowRuns/stepSpawner.ts so all backstops get the same hardening
// in one place:
//
//   1. Configurable shutdown-reason gate. The original snippet only fired
//      on `reason === 'quit'` to avoid flipping a task on `/new`, `/reload`,
//      `/fork` — for sites with a kill-by-cwd side effect this is right;
//      for sites without it (workflow steps, post-merge hooks, prompt
//      customization) we accept any shutdown reason so abnormal exits
//      still produce a callback.
//   2. A short timeout on the POST so a wedged backend doesn't strand
//      session_shutdown.
//   3. A small retry loop so a transient socket / DNS hiccup during
//      shutdown isn't immediately fatal.
//   4. A sentinel file written next to the extension that records the
//      reason, attempt count, outcome, and any error message. Lets us
//      diagnose Pi-side reliability issues without server-side guessing —
//      "did the extension fire? did the POST succeed?" is now visible
//      on disk.
//   5. Optional `promptFile` mode for the prompt-customization endpoint:
//      reads the file the model wrote and POSTs it as JSON `{prompt}`.
//
// Adding a new Pi-extension call-site = add a `PiExtensionSite` value,
// pick a sentinel filename, decide whether to gate on `quit`, and call
// `installPiCompletionExtension`. Don't inline a fresh copy.
//
// This file is the stable public facade. Types, defaults, and renderer
// composition live in `piExtension/renderer.ts`; the extension source template
// lives in `piExtension/template.ts` (how the generated TS is assembled), and
// filesystem install + sentinel-read logic lives in `piExtension/install.ts`.
// Keep all public exports stable — callers import them from `./piExtension.js`.

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
