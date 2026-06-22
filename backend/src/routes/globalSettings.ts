// Machine-global settings endpoints. Currently exposes the spawn queue's
// softCap (`maxConcurrentAgents`). Distinct from /api/settings, which is
// per-project.

import { Router } from 'express';
import {
  clampMaxConcurrentAgents,
  getGlobalSettings,
  updateGlobalSettings,
  type GlobalSettings,
} from '../globalSettings.js';
import { setSpawnQueueSoftCap } from '../spawnQueue.js';
import { reconcilePiModelsJson } from '../piModels.js';

export function buildGlobalSettingsRouter(): Router {
  const r = Router();

  r.get('/api/global-settings', async (_req, res) => {
    res.json(await getGlobalSettings());
  });

  r.patch('/api/global-settings', async (req, res) => {
    const body = (req.body || {}) as Partial<GlobalSettings>;
    const patch: Partial<GlobalSettings> = {};
    if (body.maxConcurrentAgents !== undefined) {
      const n = Number(body.maxConcurrentAgents);
      if (!Number.isFinite(n) || n < 1) {
        return res
          .status(400)
          .json({ error: 'maxConcurrentAgents must be a positive integer' });
      }
      patch.maxConcurrentAgents = clampMaxConcurrentAgents(n);
    }
    // Pass the other machine-global fields through to updateGlobalSettings,
    // which sanitizes each. (Previously this handler only forwarded
    // maxConcurrentAgents, silently dropping every other field — so MCP
    // custom-server / Pi-menu / Pi-provider saves never persisted.)
    if (body.mcpCustomServers !== undefined) patch.mcpCustomServers = body.mcpCustomServers;
    if (body.mcpBuiltinOverrides !== undefined) {
      patch.mcpBuiltinOverrides = body.mcpBuiltinOverrides;
    }
    if (body.piModelMenu !== undefined) patch.piModelMenu = body.piModelMenu;
    if (body.piProviders !== undefined) patch.piProviders = body.piProviders;

    const updated = await updateGlobalSettings(patch);
    // Apply the new softCap to the live queue so it takes effect without a
    // restart (raising it drains deferred spawns into the new headroom).
    setSpawnQueueSoftCap(updated.maxConcurrentAgents);
    // When Pi providers changed, reconcile them into ~/.pi/agent/models.json
    // so the new endpoint's models are immediately discoverable.
    if (body.piProviders !== undefined) {
      await reconcilePiModelsJson();
    }
    res.json(updated);
  });

  return r;
}
