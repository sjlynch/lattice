// File-system scan (the 3D graph's source) + the agent-facing dead-code
// summary. The scan honors client cancellation so a refresh mid-scan doesn't
// burn CPU on a response no one will read.

import { Router } from 'express';
import { canonicalProjectPath } from '../../projectPath.js';
import { collectAreaSourceFiles } from '../../sourceAreasCollect.js';
import { normalizeWorkflowSplit, normalizeAreaPaths } from '../../shared/workflowSplit.js';
import { partitionSourceAreas, resolveCustomAreas, buildSourceTree, type SourceAreasResult } from '../../shared/sourceAreas.js';
import { scanCoordinator } from '../../scanner/coordinator.js';
import { ScanCancelledError } from '../../scanner/fileMetrics.js';
import { getDeadCodeSummary } from '../../deadCode.js';
import { readPathParam, readProjectParam } from '../projectParam.js';

export function buildScanRouter(
  defaultRoot: string,
  requestScan = scanCoordinator.request.bind(scanCoordinator),
): Router {
  const r = Router();

  r.get('/api/source-areas', async (req, res) => {
    const project = readProjectParam(req, res, { source: 'query' });
    if (project === null) return;
    const count = typeof req.query.count === 'string' ? Number(req.query.count) : NaN;
    if (!Number.isInteger(count) || count < 2 || count > 16) {
      res.status(400).json({ error: 'count must be an integer from 2 to 16' });
      return;
    }
    const root = canonicalProjectPath(project);
    const { files, packageRoots } = await collectAreaSourceFiles(root);
    const areas = partitionSourceAreas(files, count, { packageRoots });
    const result: SourceAreasResult = { areas, totalFiles: areas.reduce((sum, area) => sum + area.files, 0) };
    res.json(result);
  });

  r.post('/api/source-areas/resolve', async (req, res) => {
    const project = readProjectParam(req, res);
    if (project === null) return;
    const { areas, includeRest } = req.body ?? {};
    if (!Array.isArray(areas) || areas.length > 16 || (includeRest !== undefined && typeof includeRest !== 'boolean') || areas.some((a) =>
      !a || typeof a.label !== 'string' || !a.label.trim() || a.label.trim().length > 80 || !Array.isArray(a.paths) || !a.paths.length || normalizeAreaPaths(a.paths).length !== a.paths.length)) {
      res.status(400).json({ error: 'areas must contain at most 16 labelled areas with repo-relative POSIX paths; includeRest must be boolean' });
      return;
    }
    const split = normalizeWorkflowSplit({ mode: 'custom', areas, includeRest })!;
    const { files } = await collectAreaSourceFiles(project);
    res.json({ ...resolveCustomAreas(files, split.areas!, split.includeRest !== false), totalFiles: files.length });
  });

  r.get('/api/source-tree', async (req, res) => {
    const project = readProjectParam(req, res, { source: 'query' });
    if (project === null) return;
    const { files } = await collectAreaSourceFiles(project);
    res.json(buildSourceTree(files));
  });

  r.get('/api/scan', async (req, res) => {
    const target = readPathParam(req, res, defaultRoot);
    if (target === null) return;
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
    const target = readPathParam(req, res, defaultRoot);
    if (target === null) return;
    try {
      res.json(await getDeadCodeSummary(target));
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  return r;
}
