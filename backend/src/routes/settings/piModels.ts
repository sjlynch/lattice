// GET /api/pi-models — Pi models for the harness dropdowns: the full
// `pi --list-models` list, the curated "Pi — X" menu (globalSettings.piModelMenu,
// or the default menu), and Pi's current default model. Machine-global (Pi
// config is), so no project param. Returns empty lists when `pi` isn't
// installed. See ../../piModels.ts.

import { Router } from 'express';
import { getGlobalSettings } from '../../globalSettings.js';
import { getPiModels } from '../../piModels.js';

export function buildPiModelsRouter(): Router {
  const r = Router();

  r.get('/api/pi-models', async (_req, res) => {
    const global = await getGlobalSettings();
    res.json(await getPiModels(global.piModelMenu));
  });

  return r;
}
