// Per-project user settings (sidebar width, harness preference, etc.) plus
// the read-only project-environment probe that backs the "Agent
// instructions" tab in the settings dialog.

import { Router } from 'express';
import { getUserSettings, patchUserSettings, type UserSettings } from '../userSettings.js';
import { describeProjectEnvs } from '../worktree.js';
import { canonicalProjectPath } from '../projectPath.js';
import { buildInstructionTemplateEditorData } from '../instructionTemplates.js';
import { getGlobalSettings } from '../globalSettings.js';
import { getPiModels } from '../piModels.js';

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

  // Pi models for the harness dropdowns: the full `pi --list-models` list, the
  // curated "Pi — X" menu (globalSettings.piModelMenu, or the default menu),
  // and Pi's current default model. Machine-global (Pi config is), so no
  // project param. Returns empty lists when `pi` isn't installed. See
  // ../piModels.ts.
  r.get('/api/pi-models', async (_req, res) => {
    const global = await getGlobalSettings();
    res.json(await getPiModels(global.piModelMenu));
  });

  // The editable instruction templates for a project — each template's default
  // markdown, the project's current (override-or-default) text, and its token
  // docs. Backs the settings dialog's "Agent prompts" tab. Edits are saved back
  // through PATCH /api/settings (`instructionTemplateOverrides`). Read-only.
  r.get('/api/instruction-templates', async (req, res) => {
    const project = typeof req.query.project === 'string' ? req.query.project : '';
    if (!project) return res.status(400).json({ error: 'project required' });
    const templates = await buildInstructionTemplateEditorData(project);
    res.json({ templates });
  });

  return r;
}
