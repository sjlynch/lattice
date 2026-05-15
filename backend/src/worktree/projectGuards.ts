// Stable facade for project-repo guard helpers. The focused modules under
// `projectGuards/` own the individual concerns; keep this file so existing
// imports from `./projectGuards.js` and `../worktree.js` stay stable.

export {
  ensureLatticeGitignore,
  LATTICE_GITIGNORE_MARKER,
} from './projectGuards/gitignore.js';
export {
  ensureLatticeRepoExclude,
  LATTICE_REPO_EXCLUDE_ENTRIES,
  LATTICE_REPO_EXCLUDE_MARKER,
} from './projectGuards/repoExclude.js';
export { verifyEssentialExclusions } from './projectGuards/verify.js';
export { untrackOwnedFilesInRepo } from './projectGuards/untrack.js';
