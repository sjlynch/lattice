// Composes the per-concern "settings" routers into the single export consumed
// by server/app.ts. Each sub-router lives in `routes/settings/`:
//
//   - userSettings.ts        : /api/settings (GET/PATCH per-project settings)
//   - projectEnv.ts          : /api/project-env (package-manager env probe)
//   - instructionTemplates.ts: /api/instruction-templates (Agent prompts tab)
//   - harnessSystemPrompts.ts: /api/harness-system-prompts (Agent prompts tab)
//   - piModels.ts            : /api/pi-models (Pi model list + curated menu)
//   - piEndpoints.ts         : /api/pi-endpoints/probe (Pi "Detect models")
//   - codexModels.ts         : /api/codex-models (Codex model dropdown list)
//
// Paths are all distinct, so mount order is not significant.

import { Router } from 'express';
import { buildUserSettingsRouter } from './settings/userSettings.js';
import { buildSpecGapsRouter } from './settings/specGaps.js';
import { buildProjectEnvRouter } from './settings/projectEnv.js';
import { buildInstructionTemplatesRouter } from './settings/instructionTemplates.js';
import { buildHarnessSystemPromptsRouter } from './settings/harnessSystemPrompts.js';
import { buildPiModelsRouter } from './settings/piModels.js';
import { buildPiEndpointsRouter } from './settings/piEndpoints.js';
import { buildCodexModelsRouter } from './settings/codexModels.js';

export function buildSettingsRouter(): Router {
  const r = Router();
  r.use(buildUserSettingsRouter());
  r.use(buildSpecGapsRouter());
  r.use(buildProjectEnvRouter());
  r.use(buildInstructionTemplatesRouter());
  r.use(buildHarnessSystemPromptsRouter());
  r.use(buildPiModelsRouter());
  r.use(buildPiEndpointsRouter());
  r.use(buildCodexModelsRouter());
  return r;
}
