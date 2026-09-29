// POST /api/pi-endpoints/probe — "Detect models" for the Settings → Pi
// endpoint form: GET <baseUrl>/models on an OpenAI-compatible server and return
// what it offers as `{models: [{id, contextWindow?}]}` — the context length
// rides along so a detected model can be written into models.json with the
// server's real window instead of Pi's conservative default. JSON body
// `{baseUrl, apiKey?, headers?}`. Errors (bad URL / unreachable / non-200) come back as a
// 400 with the message so the form can surface it.

import { Router } from 'express';
import { probeEndpointModels } from '../../piModels.js';

export function buildPiEndpointsRouter(): Router {
  const r = Router();

  r.post('/api/pi-endpoints/probe', async (req, res) => {
    if (!req.is('application/json')) {
      return res.status(415).json({ error: 'application/json required' });
    }
    const body = (req.body || {}) as { baseUrl?: unknown; apiKey?: unknown; headers?: unknown };
    if (typeof body.baseUrl !== 'string' || !body.baseUrl.trim()) {
      return res.status(400).json({ error: 'baseUrl required' });
    }
    try {
      const models = await probeEndpointModels(
        body.baseUrl,
        typeof body.apiKey === 'string' ? body.apiKey : undefined,
        // The probe validates this untrusted map before making a request.
        body.headers as Record<string, string> | undefined,
      );
      res.json({ models });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message || 'probe failed' });
    }
  });

  return r;
}
