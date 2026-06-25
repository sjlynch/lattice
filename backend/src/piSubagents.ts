// Pi sub-agents auto-install — re-export barrel.
//
// Auto-installs the `@tintinweb/pi-subagents` Pi extension into a Lattice-owned
// shared location and drops a tiny re-export *shim* that loads it ONLY in Pi
// sessions associated with a Lattice project — never touching the user's global
// `~/.pi/agent/settings.json` (so a `pi` they run outside Lattice is untouched).
//
// The implementation is split by concern under ./piSubagents/:
//   - paths.ts   — install dir + package-entry resolution (why a shared,
//                  project-local `pi install … -l`, not a global install).
//   - install.ts — the `pi install … -l` spawn execution.
//   - ensure.ts  — single-flight install state (resolved entry + ensure/get).
//   - render.ts  — pure rendering of the discovery shim source + its filename.
//   - shim.ts    — writing the shim into a session cwd's `.pi/extensions/`.
//
// This barrel keeps the historical `./piSubagents.js` import path working for
// every consumer (server/startup, routes/projectClaude, worktree/setupFiles,
// workflowRuns/stepSpawner, postMergeHooks/stopHook,
// workflowPromptCustomizations, the test) — the public surface is unchanged.

export {
  ensurePiSubagentsInstalled,
  getPiSubagentsEntry,
} from './piSubagents/ensure.js';
export {
  PI_SUBAGENTS_SHIM_FILENAME,
  renderPiSubagentsShim,
} from './piSubagents/render.js';
export { installPiSubagentsShim } from './piSubagents/shim.js';
