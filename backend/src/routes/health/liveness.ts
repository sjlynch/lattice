// Liveness + boot-time probes the UI hits on open: the health ping, the
// harness-availability list, and the default project root. No git, no scan —
// just fast, dependency-light status.

import { Router } from 'express';
import { detectHarnesses, resetHarnessCache } from '../../harnessDetect.js';

export function buildLivenessRouter(defaultRoot: string): Router {
  const r = Router();

  r.get('/api/health', (_req, res) => {
    res.json({ ok: true });
  });

  r.get('/api/harnesses', async (req, res) => {
    if (req.query.refresh === '1') resetHarnessCache();
    res.json(await detectHarnesses());
  });

  r.get('/api/default-root', (_req, res) => {
    res.json({ path: defaultRoot });
  });

  return r;
}
