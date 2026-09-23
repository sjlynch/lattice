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
import { setSpawnQueueResourceGovernor, setSpawnQueueSoftCap } from '../spawnQueue.js';
import { reconcilePiModelsJson, refreshEndpointDiscovery } from '../piModels.js';
import { PI_MODELS_CONFIG } from '../piModels/config.js';

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
    if (body.opengrep !== undefined) patch.opengrep = body.opengrep;
    if (body.minFreeDiskGb !== undefined) {
      const n = Number(body.minFreeDiskGb);
      if (!Number.isFinite(n) || n < 0) {
        return res.status(400).json({ error: 'minFreeDiskGb must be a non-negative number' });
      }
      patch.minFreeDiskGb = n;
    }
    if (body.autoMergeOnLowDisk !== undefined) {
      if (typeof body.autoMergeOnLowDisk !== 'boolean') {
        return res.status(400).json({ error: 'autoMergeOnLowDisk must be a boolean' });
      }
      patch.autoMergeOnLowDisk = body.autoMergeOnLowDisk;
    }
    if (body.resourceGovernor !== undefined) {
      if (typeof body.resourceGovernor !== 'boolean') {
        return res.status(400).json({ error: 'resourceGovernor must be a boolean' });
      }
      patch.resourceGovernor = body.resourceGovernor;
    }

    const updated = await updateGlobalSettings(patch);
    // Apply the new softCap to the live queue so it takes effect without a
    // restart (raising it drains deferred spawns into the new headroom).
    setSpawnQueueSoftCap(updated.maxConcurrentAgents);
    setSpawnQueueResourceGovernor(updated.resourceGovernor !== false);
    // When Pi providers changed, reconcile them into ~/.pi/agent/models.json
    // so the new endpoint's models are immediately discoverable, then probe the
    // auto-discover endpoints right away (bypassing the TTL) — that is what
    // makes "paste a base URL, save" enough to get a working "Pi — X" row
    // without a manual "Detect models" round trip.
    if (body.piProviders !== undefined) {
      await reconcilePiModelsJson();
      // `force` so this never adopts a sweep that started before the save it is
      // reacting to; bounded so saving with an endpoint offline still returns
      // promptly.
      await refreshEndpointDiscovery({
        force: true,
        maxWaitMs: PI_MODELS_CONFIG.discoveryAwaitMs,
      });
    }
    res.json(updated);
  });

  return r;
}
