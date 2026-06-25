// Composes the per-concern "settings" routers into the single export consumed
// by server/app.ts. Each sub-router lives in `routes/settings/`:
//
//   - userSettings.ts        : /api/settings (GET/PATCH per-project settings)
//   - projectEnv.ts          : /api/project-env (package-manager env probe)
//   - instructionTemplates.ts: /api/instruction-templates (Agent prompts tab)
//   - piModels.ts            : /api/pi-models (Pi model list + curated menu)
//   - piEndpoints.ts         : /api/pi-endpoints/probe (Pi "Detect models")
//
// Paths are all distinct, so mount order is not significant.

import { Router } from 'express';
import { buildUserSettingsRouter } from './settings/userSettings.js';
import { buildProjectEnvRouter } from './settings/projectEnv.js';
import { buildInstructionTemplatesRouter } from './settings/instructionTemplates.js';
import { buildPiModelsRouter } from './settings/piModels.js';
import { buildPiEndpointsRouter } from './settings/piEndpoints.js';

export function buildSettingsRouter(): Router {
  const r = Router();
  r.use(buildUserSettingsRouter());
  r.use(buildProjectEnvRouter());
  r.use(buildInstructionTemplatesRouter());
  r.use(buildPiModelsRouter());
  r.use(buildPiEndpointsRouter());
  return r;
}
