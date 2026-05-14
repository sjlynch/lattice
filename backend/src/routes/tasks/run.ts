// Thin composer for the run / resume / merge orchestration endpoints.
// The per-endpoint handlers live next to this file so each route owns its
// own setup and response-shaping helpers.

import { Router } from 'express';
import { buildTaskMergeRoute } from './mergeRoute.js';
import { buildTaskResumeRoute } from './resumeRoute.js';
import { buildTaskRunRoute } from './runRoute.js';

export function buildTaskRunRouter(backendOrigin: string): Router {
  const r = Router();
  r.use(buildTaskRunRoute(backendOrigin));
  r.use(buildTaskResumeRoute());
  r.use(buildTaskMergeRoute(backendOrigin));
  return r;
}
