// Composes the per-concern workflow routers into the single export consumed
// by the rest of the backend. Each sub-router lives in `routes/workflows/`:
//
//   - crud.ts                 : list / create / update / delete workflow defs
//   - runs.ts                 : run start + Stop-hook step-completion callback
//                               + cancel + active-runs snapshot
//   - promptCustomizations.ts : prompt-customization start / status / callback
//
// Workflow runs are advanced by Stop-hook POSTs to /steps/:n/complete — not
// by watching task state.

import { Router } from 'express';
import { buildWorkflowCrudRouter } from './workflows/crud.js';
import { buildWorkflowRunsRouter } from './workflows/runs.js';
import { buildWorkflowPromptCustomizationsRouter } from './workflows/promptCustomizations.js';

export function buildWorkflowsRouter(backendOrigin: string): Router {
  const r = Router();
  r.use(buildWorkflowCrudRouter());
  r.use(buildWorkflowRunsRouter(backendOrigin));
  r.use(buildWorkflowPromptCustomizationsRouter(backendOrigin));
  return r;
}
