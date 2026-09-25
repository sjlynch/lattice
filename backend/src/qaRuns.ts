// QA e2e-run public facade. A QA run spawns a one-off Playwright-enabled
// Claude session that exercises a merged QA-lane task end-to-end. Implementation
// is split under `qaRuns/` mirroring `pushRuns/` — registry, home-scoped scratch
// paths, instruction rendering, Stop-hook setup, session materialization, and
// guarded cleanup each stay independently reviewable.

export type { QaRun, QaSession, QaVerdict } from './qaRuns/types.js';
export {
  forgetQaRun,
  getQaRun,
  markQaRunDone,
  markQaRunMovedToDone,
  qaRunStore,
  recordQaRun,
  recordQaRunAutoClose,
  recordQaVerdict,
  restoreQaRun,
} from './qaRuns/registry.js';
export { startQaSession } from './qaRuns/session.js';
export type { StartedQaSession, StartQaSessionArgs } from './qaRuns/session.js';
export { cleanupQaSession } from './qaRuns/cleanup.js';
export { qaAgentId } from './qaRuns/stopHook.js';
export { applyQaVerdict, applyRecordedQaVerdict } from './qaRuns/verdict.js';
export type { QaVerdictInput, QaVerdictOutcome } from './qaRuns/verdict.js';
