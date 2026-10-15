// GET /api/codex-models — Codex models for the model dropdowns, read from the
// Codex CLI's own catalog cache. Machine-global (no project param); empty when
// Codex hasn't cached its catalog yet. See ../../codexModels.ts.

import { Router } from 'express';
import { listCodexModels } from '../../codexModels.js';

export function buildCodexModelsRouter(): Router {
  const r = Router();
  r.get('/api/codex-models', async (_req, res) => {
    res.json({ models: await listCodexModels() });
  });
  return r;
}
