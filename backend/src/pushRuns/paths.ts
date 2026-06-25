import { createHomeScratchPaths } from '../homeScratch/paths.js';

// Push-run scratch lives at `~/.lattice/per-project/<hash>/push/<id>/` —
// home-scoped, OUTSIDE the repo, so the bounded recursive cleanup can never
// reach the project tree. Id minting, root/dir construction, and the
// `.git`-deletion path-safety guard are all shared via the homeScratch factory.
export const PUSH_RUNS_DIRNAME = 'push';

export const pushPaths = createHomeScratchPaths({
  dirName: PUSH_RUNS_DIRNAME,
  idPrefix: 'push',
  logLabel: '[pushRuns]',
  noun: 'push session',
});

export const createPushSessionId = pushPaths.createSessionId;
export const pushSessionsRoot = pushPaths.sessionsRoot;
export const pushSessionDir = pushPaths.sessionDir;
export const assertSafePushSessionPath = pushPaths.assertSafeSessionPath;
