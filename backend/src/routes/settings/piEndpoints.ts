// POST /api/pi-endpoints/probe — "Detect models" for the Settings → Pi
// endpoint form: GET <baseUrl>/models on an OpenAI-compatible server and return
// the model ids. Body `{baseUrl, apiKey?}`. Errors (bad URL / unreachable /
// non-200) come back as a 400 with the message so the form can surface it.

import { Router } from 'express';
import { probeEndpointModels } from '../../piModels.js';

export function buildPiEndpointsRouter(): Router {
  const r = Router();

  r.post('/api/pi-endpoints/probe', async (req, res) => {
    const body = (req.body || {}) as { baseUrl?: unknown; apiKey?: unknown };
    if (typeof body.baseUrl !== 'string' || !body.baseUrl.trim()) {
      return res.status(400).json({ error: 'baseUrl required' });
    }
    try {
      const models = await probeEndpointModels(
        body.baseUrl,
        typeof body.apiKey === 'string' ? body.apiKey : undefined,
      );
      res.json({ models });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message || 'probe failed' });
    }
  });

  return r;
}
