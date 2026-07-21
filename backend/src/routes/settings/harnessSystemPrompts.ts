// GET /api/harness-system-prompts — the per-harness system-prompt editor data
// for a project: each harness's read-only default overview plus the project's
// current Append / Replace override text. Backs the settings dialog's "Agent
// prompts" tab ("Harness system prompts" section). Edits are saved back through
// PATCH /api/settings (`harnessSystemPrompts`). Read-only.

import { Router } from 'express';
import { buildHarnessSystemPromptEditorData } from '../../harnessSystemPrompts.js';

export function buildHarnessSystemPromptsRouter(): Router {
  const r = Router();

  r.get('/api/harness-system-prompts', async (req, res) => {
    const project = typeof req.query.project === 'string' ? req.query.project : '';
    if (!project) return res.status(400).json({ error: 'project required' });
    const harnesses = await buildHarnessSystemPromptEditorData(project);
    res.json({ harnesses });
  });

  return r;
}
