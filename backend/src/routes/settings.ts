// Per-project user settings (sidebar width, harness preference, etc.) plus
// the read-only project-environment probe that backs the "Agent
// instructions" tab in the settings dialog.

import { Router } from 'express';
import { getUserSettings, patchUserSettings, type UserSettings } from '../userSettings.js';
import { describeProjectEnvs } from '../worktree.js';
import { canonicalProjectPath } from '../projectPath.js';

export function buildSettingsRouter(): Router {
  const r = Router();

  r.get('/api/settings', async (req, res) => {
    const project = typeof req.query.project === 'string' ? req.query.project : '';
    if (!project) return res.status(400).json({ error: 'project required' });
    res.json(await getUserSettings(project));
  });

  r.patch('/api/settings', async (req, res) => {
    const project = typeof req.query.project === 'string' ? req.query.project : '';
    if (!project) return res.status(400).json({ error: 'project required' });
    const partial = (req.body || {}) as Partial<UserSettings>;
    res.json(await patchUserSettings(project, partial));
  });

  // Auto-detected package-manager environments for a project, each with the
  // default and effective (post-override) "fresh worktree, don't reinstall"
  // note. Drives the settings dialog so users can discover and tweak what
  // Lattice injects into LATTICE_TASK.md. Read-only; never mutates anything.
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
