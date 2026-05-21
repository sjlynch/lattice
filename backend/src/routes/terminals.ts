// Debug + lifecycle endpoints for PTY sessions owned by the terminal-server
// subprocess. Sessions are listed and killed via the proxy because the
// terminal server is detached and lives in a separate process.

import { Router } from 'express';
import { proxyKillSession, proxyListSessions } from '../terminalProxy.js';
import { getSpawnQueueSnapshot } from '../spawnQueue.js';

export function buildTerminalsRouter(): Router {
  const r = Router();

  r.get('/api/terminals', async (_req, res) => {
    res.json(await proxyListSessions());
  });

  r.delete('/api/terminals/:id', async (req, res) => {
    const ok = await proxyKillSession(req.params.id);
    if (!ok) return res.status(404).json({ error: 'not found' });
    res.json({ ok: true });
  });

  // Debug: spawn-queue state — pending/in-flight items, reserved slots, the
  // last polled session count, effective concurrency, and the softCap.
  r.get('/api/spawn-queue', (_req, res) => {
    res.json(getSpawnQueueSnapshot());
  });

  return r;
}
