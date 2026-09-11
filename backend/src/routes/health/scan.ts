// File-system scan (the 3D graph's source) + the agent-facing dead-code
// summary. The scan honors client cancellation so a refresh mid-scan doesn't
// burn CPU on a response no one will read.

import { Router } from 'express';
import { scanCoordinator } from '../../scanner/coordinator.js';
import { ScanCancelledError } from '../../scanner/fileMetrics.js';
import { getDeadCodeSummary } from '../../deadCode.js';

export function buildScanRouter(
  defaultRoot: string,
  requestScan = scanCoordinator.request.bind(scanCoordinator),
): Router {
  const r = Router();

  r.get('/api/scan', async (req, res) => {
    const target =
      typeof req.query.path === 'string' ? req.query.path : defaultRoot;
    const startedAt = Date.now();
    console.log(`[scan] start ${target}`);
    // Track whether the client gave up first. The browser cancels the
    // request on refresh/navigate, and the vite dev proxy aborts the
    // upstream socket in turn. computeFileMetrics polls this between
    // batches of files and throws ScanCancelledError, so we don't burn
    // CPU on a response no one will read — critical when the user
    // refreshes mid-scan on a multi-thousand-file project.
    let clientGone = false;
    const controller = new AbortController();
    const onClose = () => {
      if (!res.writableEnded) {
        clientGone = true;
        controller.abort();
        console.warn(
          `[scan] client disconnected after ${Date.now() - startedAt}ms (${target})`,
        );
      }
    };
    // IncomingMessage.close also fires for a fully received request. Only the
    // unfinished response closing means the GET's consumer actually went away.
    res.on('close', onClose);
    try {
      const result = await requestScan(target, controller.signal);
      if (clientGone) return;
      const elapsed = Date.now() - startedAt;
      console.log(
        `[scan] done ${target} — ${result.nodes.length} nodes, ${result.links.length} links in ${elapsed}ms`,
      );
      res.json(result);
    } catch (err) {
      if (err instanceof ScanCancelledError) {
        console.log(
          `[scan] cancelled ${target} after ${Date.now() - startedAt}ms (client gone)`,
        );
        return;
      }
      console.error(
        `[scan] failed ${target} after ${Date.now() - startedAt}ms:`,
        err,
      );
      if (clientGone) return;
      res.status(400).json({ error: (err as Error).message });
    } finally {
      res.off('close', onClose);
    }
  });

  // Agent-facing view of the dead-code analyzer: the list of files the
  // reachability pass confidently flags as unreachable (empty when the
  // confidence guard tripped — see deadCode.ts). Drives the conditional
  // dead-code note in LATTICE_TASK.md and lets an in-worktree agent fetch
  // the current list to investigate before removing anything.
  r.get('/api/health/dead-code', async (req, res) => {
    const target =
      typeof req.query.project === 'string'
        ? req.query.project
        : typeof req.query.path === 'string'
          ? req.query.path
          : defaultRoot;
    try {
      res.json(await getDeadCodeSummary(target));
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  return r;
}
