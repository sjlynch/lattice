// API barrel. Components import from `'../api'` which resolves here under
// Vite's bundler module resolution. Implementation lives in sibling
// modules grouped by domain.

export * from './types';
export { HttpError } from './http';
export * from './scan';
export * from './settings';
export * from './globalSettings';
export * from './mcp';
export * from './tasks';
export * from './mergeRuns';
export {
  checkGit,
  fetchPushRunStatus,
  forgetPushRun,
  startPushRun,
} from './pushRuns';
export { initProjectGit, previewProjectInit } from './projectInit';
export {
  fetchQaRunStatus,
  forgetQaRun,
  startQaRun,
} from './qaRuns';
export {
  abortPostMergeHook,
  getActivePostMergeHook,
  subscribePostMergeHooks,
} from './postMergeHooks';
export * from './workflows';
export * from './health';
export * from './terminals';
export * from './terminalTabs';
