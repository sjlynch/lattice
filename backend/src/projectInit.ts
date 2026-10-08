// Public surface of the project-init module. Route handlers and tests import
// from here; the internals stay in the sibling files.

export { probeProjectGit } from './projectInit/probe.js';
export { refuseInitReason } from './projectInit/guards.js';
export { buildStarterGitignore } from './projectInit/gitignoreTemplate.js';
export { previewProjectInit } from './projectInit/preview.js';
export { initProjectGit, type InitProjectGitOptions } from './projectInit/init.js';
export {
  ProjectInitError,
  type ProjectGitProbe,
  type ProjectGitState,
  type ProjectInitErrorCode,
  type ProjectInitPreview,
  type ProjectInitResult,
} from './projectInit/types.js';
