// Public surface of the project-init module. Route handlers and tests import
// from here; the internals stay in the sibling files.

export { probeProjectGit } from './probe.js';
export { refuseInitReason } from './guards.js';
export { buildStarterGitignore } from './gitignoreTemplate.js';
export { previewProjectInit } from './preview.js';
export { initProjectGit, type InitProjectGitOptions } from './init.js';
export {
  ProjectInitError,
  type ProjectGitProbe,
  type ProjectGitState,
  type ProjectInitErrorCode,
  type ProjectInitPreview,
  type ProjectInitResult,
} from './types.js';
