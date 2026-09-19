// GET /api/pi-models — Pi models for the harness dropdowns: the full
// `pi --list-models` list, the curated "Pi — X" menu (globalSettings.piModelMenu,
// or the default menu), and Pi's current default model. Machine-global (Pi
// config is), so no project param. Returns empty lists when `pi` isn't
// installed. Probes the managed endpoints first so the menu reflects what they
// are serving right now. See ../../piModels.ts.

import { Router } from 'express';
import { getGlobalSettings } from '../../globalSettings.js';
import { getPiModels, refreshEndpointDiscovery } from '../../piModels.js';
import { PI_MODELS_CONFIG } from '../../piModels/config.js';

export function buildPiModelsRouter(): Router {
  const r = Router();

  r.get('/api/pi-models', async (_req, res) => {
    // Re-probe the managed endpoints first (TTL-throttled, best-effort) so a
    // local server restarted on a different model is reflected the moment a
    // harness dropdown opens, rather than after the next Settings save.
    // Bounded: an endpoint that is down would otherwise hold the dropdown open
    // for the full probe timeout. Past the bound we answer from current state
    // and the sweep lands for the next open.
    await refreshEndpointDiscovery({
      maxWaitMs: PI_MODELS_CONFIG.discoveryAwaitMs,
    });
    const global = await getGlobalSettings();
    res.json(await getPiModels(global.piModelMenu));
  });

  return r;
}
