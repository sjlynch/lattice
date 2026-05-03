// Health checks, default-root probe, file-system scan, and folder browser.
// Read-only endpoints — no mutations, no side effects beyond filesystem reads.

import { Router } from 'express';
import { scan } from '../scanner.js';
import { listDir } from '../fsbrowse.js';

export function buildHealthRouter(defaultRoot: string): Router {
  const r = Router();

  r.get('/api/health', (_req, res) => {
    res.json({ ok: true });
  });

  r.get('/api/default-root', (_req, res) => {
    res.json({ path: defaultRoot });
  });

  r.get('/api/scan', async (req, res) => {
    const target =
      typeof req.query.path === 'string' ? req.query.path : defaultRoot;
    try {
      const result = await scan(target);
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  r.get('/api/list-dir', async (req, res) => {
    const target = typeof req.query.path === 'string' ? req.query.path : undefined;
    try {
      const result = await listDir(target);
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  return r;
}
