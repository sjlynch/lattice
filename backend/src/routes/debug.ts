// Memory debugging (see ../memDiag/CLAUDE.md):
//
//   GET  /api/debug/memory         — this backend's sample, gauges, trend,
//                                    V8 heap spaces, last browser samples
//   POST /api/debug/heap-snapshot  — write a .heapsnapshot to ~/.lattice/logs
//   POST /api/debug/client-memory  — a browser tab's periodic sample; printed
//                                    as a `[mem] browser#…` console line
//
// Localhost-only like every route; the app-wide Origin guard keeps a
// cross-origin page from triggering the (event-loop-blocking) snapshot.

import { Router } from 'express';

import { memDiagReport } from '../memDiag.js';
import {
  browserMemReport,
  parseBrowserMemSample,
  recordBrowserMemSample,
} from '../memDiag/browser.js';
import { writeHeapSnapshotFile } from '../memDiag/heapSnapshot.js';

export function buildDebugRouter(): Router {
  const r = Router();

  r.get('/api/debug/memory', async (_req, res) => {
    res.json({ ...(await memDiagReport()), browsers: browserMemReport() });
  });

  r.post('/api/debug/heap-snapshot', (_req, res) => {
    const started = Date.now();
    const file = writeHeapSnapshotFile('backend');
    console.log(`[mem] heap snapshot written in ${Date.now() - started}ms: ${file}`);
    res.json({ file });
  });

  r.post('/api/debug/client-memory', (req, res) => {
    const sample = parseBrowserMemSample(req.body);
    if (!sample) return res.status(400).json({ error: 'invalid memory sample' });
    res.json({ line: recordBrowserMemSample(sample) });
  });

  return r;
}
