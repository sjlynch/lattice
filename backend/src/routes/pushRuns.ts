// Push-run lifecycle: spawn a Claude terminal that commits any pending
// changes and pushes the project to its remote, then automatically closes
// itself when Claude stops (via a settings.local.json Stop hook).

import { Router } from 'express';
import path from 'node:path';
import fs from 'node:fs/promises';
import { canonicalProjectPath } from '../projectPath.js';
import { proxyCreateSession } from '../terminalProxy.js';
import {
  cleanupPushSession,
  forgetPushRun,
  getPushRun,
  markPushRunDone,
  recordPushRun,
  setupPushSession,
} from '../pushRuns.js';

export function buildPushRunsRouter(backendOrigin: string): Router {
  const r = Router();

  // Quick filesystem probe — used by the task board to decide whether to
  // surface the push button. A `.git` entry can be either a directory (regular
  // repo) or a file (worktree pointer); both count.
  r.get('/api/git-check', async (req, res) => {
    const raw = typeof req.query.path === 'string' ? req.query.path : '';
    if (!raw) return res.status(400).json({ error: 'path required' });
    const project = canonicalProjectPath(raw);
    try {
      const st = await fs.stat(path.join(project, '.git'));
      res.json({ hasGit: st.isDirectory() || st.isFile() });
    } catch {
      res.json({ hasGit: false });
    }
  });

  r.post('/api/push-runs', async (req, res) => {
    const raw = (req.body || {}).project as string | undefined;
    if (!raw) return res.status(400).json({ error: 'project required' });
    const project = canonicalProjectPath(raw);

    try {
      const st = await fs.stat(path.join(project, '.git'));
      if (!st.isDirectory() && !st.isFile()) {
        return res.status(400).json({ error: 'project is not a git repository' });
      }
    } catch {
      return res.status(400).json({ error: 'project is not a git repository' });
    }

    try {
      const session = await setupPushSession(project, backendOrigin);
      const command = `claude --dangerously-skip-permissions "Please read PUSH_INSTRUCTIONS.md in this directory and follow it."`;
      const sess = await proxyCreateSession({
        cwd: session.cwd,
        initialCommand: command,
        projectPath: project,
      });
      if ('error' in sess) {
        await cleanupPushSession(project, session.id);
        return res.status(500).json({ error: sess.error });
      }
      recordPushRun({
        id: session.id,
        projectPath: project,
        cwd: session.cwd,
        status: 'running',
        createdAt: Date.now(),
      });
      res.json({
        id: session.id,
        command,
        cwd: session.cwd,
        serverId: sess.id,
      });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Polled by the frontend so it can close the terminal once Claude stops.
  r.get('/api/push-runs/:id', (req, res) => {
    const run = getPushRun(req.params.id);
    if (!run) return res.status(404).json({ error: 'not found' });
    res.json({ id: run.id, status: run.status, projectPath: run.projectPath });
  });

  // Stop-hook callback. Idempotent: a duplicate POST after the run has been
  // forgotten just no-ops.
  r.post('/api/push-runs/:id/done', async (req, res) => {
    const run = getPushRun(req.params.id);
    if (!run) return res.json({ ok: true });
    markPushRunDone(run.id);
    // Cleanup the temp dir off the response path so a slow Windows fs.rm
    // doesn't keep the curl call open past its 5s timeout.
    void cleanupPushSession(run.projectPath, run.id);
    res.json({ ok: true });
  });

  // Allow the frontend to drop the run from the registry once it's seen the
  // 'done' status — keeps the map from growing forever in long sessions.
  r.delete('/api/push-runs/:id', (req, res) => {
    forgetPushRun(req.params.id);
    res.json({ ok: true });
  });

  return r;
}
