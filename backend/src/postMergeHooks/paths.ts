import { createHomeScratchPaths } from '../homeScratch/paths.js';

// Home-scoped post-merge-hook scratch lives at
// `~/.lattice/per-project/<hash>/post-merge-hooks/<id>/` — OUTSIDE the repo.
// The hook *runs* with cwd=project, but its scratch dir (Stop-hook config +
// instructions) is outside the repo so any recursive cleanup is bounded the
// same way push/QA runs are. Id minting, root/dir construction, and the
// `.git`-deletion path-safety guard are shared via the homeScratch factory.
export const POST_MERGE_HOOKS_DIRNAME = 'post-merge-hooks';

export const postMergeHookPaths = createHomeScratchPaths({
  dirName: POST_MERGE_HOOKS_DIRNAME,
  idPrefix: 'pmh',
  logLabel: '[post-merge-hook]',
  noun: 'hook',
});

export const createPostMergeHookId = postMergeHookPaths.createSessionId;
export const postMergeHooksRoot = postMergeHookPaths.sessionsRoot;
export const postMergeHookDir = postMergeHookPaths.sessionDir;
export const assertSafePostMergeHookPath =
  postMergeHookPaths.assertSafeSessionPath;
