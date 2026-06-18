// Health checks, default-root probe, file-system scan, and folder browser.

import { Router } from 'express';
import { scan } from '../scanner.js';
import { ScanCancelledError } from '../scanner/fileMetrics.js';
import { createDir, listDir } from '../fsbrowse.js';
import { detectHarnesses, resetHarnessCache } from '../harnessDetect.js';
import { getGitHistory } from '../gitHistory.js';
import { getDeadCodeSummary } from '../deadCode.js';
import { exec } from '../worktree/exec.js';

const GIT_BRANCH_TIMEOUT_MS = 4000;

// Current branch of a repo's working tree (the active project folder shown in
// the navbar). `rev-parse --abbrev-ref HEAD` yields the branch name, or the
// literal "HEAD" when detached — in which case we surface the short sha so the
// navbar shows something meaningful instead of a bare "HEAD". Returns null when
// the folder isn't a git repo (or git isn't available), so the navbar can just
// omit the branch indicator.
async function getCurrentBranch(repoRoot: string): Promise<string | null> {
  try {
    const r = await exec('git', ['rev-parse', '--abbrev-ref', 'HEAD'], repoRoot, {
      timeoutMs: GIT_BRANCH_TIMEOUT_MS,
    });
    const name = r.stdout.trim();
    if (r.code !== 0 || !name) return null;
    if (name !== 'HEAD') return name;
    const sha = await exec('git', ['rev-parse', '--short', 'HEAD'], repoRoot, {
      timeoutMs: GIT_BRANCH_TIMEOUT_MS,
    });
    const short = sha.stdout.trim();
    return short ? `detached @ ${short}` : null;
  } catch {
    return null;
  }
}

export function buildHealthRouter(defaultRoot: string): Router {
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
    req.on('close', () => {
      if (!res.writableEnded) {
        clientGone = true;
        console.warn(
          `[scan] client disconnected after ${Date.now() - startedAt}ms (${target})`,
        );
      }
    });
    try {
      const result = await scan(target, { isCancelled: () => clientGone });
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

  r.get('/api/git-history', async (req, res) => {
    const target =
      typeof req.query.path === 'string' ? req.query.path : defaultRoot;
    const limit = Number(req.query.limit) || 10;
    try {
      const result = await getGitHistory(target, limit);
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  r.get('/api/git-branch', async (req, res) => {
    const target =
      typeof req.query.path === 'string' ? req.query.path : defaultRoot;
    try {
      const branch = await getCurrentBranch(target);
      res.json({ branch });
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

  r.post('/api/create-dir', async (req, res) => {
    const parent = typeof req.body.parent === 'string' ? req.body.parent : '';
    const name = typeof req.body.name === 'string' ? req.body.name : '';
    try {
      const result = await createDir(parent, name);
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  return r;
}
