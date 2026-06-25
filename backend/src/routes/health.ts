// Composes the per-family "health" routers into the single export consumed
// by server/app.ts. Each sub-router lives in `routes/health/`:
//
//   - liveness.ts : /api/health, /api/harnesses, /api/default-root
//   - scan.ts     : /api/scan (cancel-on-client-close), /api/health/dead-code
//   - gitInfo.ts  : /api/git-history, /api/git-branch
//   - browse.ts   : /api/list-dir, /api/create-dir (folder picker)
//
// Paths are all distinct exact matches, so mount order is not significant.

import { Router } from 'express';
import { buildLivenessRouter } from './health/liveness.js';
import { buildScanRouter } from './health/scan.js';
import { buildGitInfoRouter } from './health/gitInfo.js';
import { buildBrowseRouter } from './health/browse.js';

export function buildHealthRouter(defaultRoot: string): Router {
  const r = Router();
  r.use(buildLivenessRouter(defaultRoot));
  r.use(buildScanRouter(defaultRoot));
  r.use(buildGitInfoRouter(defaultRoot));
  r.use(buildBrowseRouter());
  return r;
}
