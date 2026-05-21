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

export function buildGlobalSettingsRouter(): Router {
  const r = Router();

  r.get('/api/global-settings', async (_req, res) => {
    res.json(await getGlobalSettings());
  });

  r.patch('/api/global-settings', async (req, res) => {
    const body = (req.body || {}) as { maxConcurrentAgents?: unknown };
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
    const updated = await updateGlobalSettings(patch);
    // Apply the new softCap to the live queue so it takes effect without a
    // restart (raising it drains deferred spawns into the new headroom).
    setSpawnQueueSoftCap(updated.maxConcurrentAgents);
    res.json(updated);
  });

  return r;
}
