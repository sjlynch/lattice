// Push-run public facade. Implementation is split under `pushRuns/` so the
// registry, home-scoped scratch paths, instruction rendering, Stop-hook setup,
// session materialization, and guarded cleanup stay independently reviewable.

export type { PushRun, PushSession } from './pushRuns/types.js';
export {
  forgetPushRun,
  getPushRun,
  markPushRunDone,
  recordPushRun,
  subscribePushRuns,
} from './pushRuns/registry.js';
export type { PushRunEvent } from './pushRuns/registry.js';
export { setupPushSession, startPushSession } from './pushRuns/session.js';
export type { StartedPushSession } from './pushRuns/session.js';
export { cleanupPushSession } from './pushRuns/cleanup.js';
