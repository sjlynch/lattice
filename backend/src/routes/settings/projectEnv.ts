// GET /api/project-env — read-only probe of a project's auto-detected
// package-manager environments, each with the default and effective
// (post-override) "fresh worktree, don't reinstall" note that gets prepended
// to LATTICE_TASK.md. Drives the settings dialog so users can discover and
// tweak what Lattice injects. Never mutates anything.

import { Router } from 'express';
import { describeProjectEnvs } from '../../worktree.js';
import { getUserSettings } from '../../userSettings.js';
import { canonicalProjectPath } from '../../projectPath.js';

export function buildProjectEnvRouter(): Router {
  const r = Router();

  r.get('/api/project-env', async (req, res) => {
    const project = typeof req.query.project === 'string' ? req.query.project : '';
    if (!project) return res.status(400).json({ error: 'project required' });
    const repoRoot = canonicalProjectPath(project);
    const settings = await getUserSettings(repoRoot);
    const environments = await describeProjectEnvs(repoRoot, settings);
    res.json({ environments });
  });

  return r;
}
