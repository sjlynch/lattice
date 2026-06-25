import { createHomeScratchPaths } from '../homeScratch/paths.js';

// QA e2e-run scratch lives at `~/.lattice/per-project/<hash>/qa/<id>/` —
// home-scoped, OUTSIDE the repo, so the bounded recursive cleanup can never
// reach the project tree (mirrors pushRuns). Id minting, root/dir construction,
// and the `.git`-deletion path-safety guard are shared via the homeScratch
// factory.
export const QA_RUNS_DIRNAME = 'qa';

export const qaPaths = createHomeScratchPaths({
  dirName: QA_RUNS_DIRNAME,
  idPrefix: 'qa',
  logLabel: '[qaRuns]',
  noun: 'qa session',
});

export const createQaSessionId = qaPaths.createSessionId;
export const qaSessionsRoot = qaPaths.sessionsRoot;
export const qaSessionDir = qaPaths.sessionDir;
export const assertSafeQaSessionPath = qaPaths.assertSafeSessionPath;
