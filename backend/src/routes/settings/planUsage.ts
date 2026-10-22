// GET /api/plan-usage[?refresh=1] — Claude and Codex subscription usage
// (% used per rate-limit window, reset times). Machine-global (no project
// param); cached server-side, `refresh=1` asks for fresh numbers. See
// ../../planUsage.ts.

import { Router } from 'express';
import { readPlanUsage } from '../../planUsage.js';

export function buildPlanUsageRouter(): Router {
  const r = Router();
  r.get('/api/plan-usage', async (req, res) => {
    res.json(await readPlanUsage({ refresh: req.query.refresh === '1' || req.query.refresh === 'true' }));
  });
  return r;
}
