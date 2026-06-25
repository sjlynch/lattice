// GET /api/instruction-templates — the editable agent instruction templates
// for a project: each template's default markdown, the project's current
// (override-or-default) text, and its `{{token}}` docs. Backs the settings
// dialog's "Agent prompts" tab. Edits are saved back through PATCH
// /api/settings (`instructionTemplateOverrides`). Read-only.

import { Router } from 'express';
import { buildInstructionTemplateEditorData } from '../../instructionTemplates.js';

export function buildInstructionTemplatesRouter(): Router {
  const r = Router();

  r.get('/api/instruction-templates', async (req, res) => {
    const project = typeof req.query.project === 'string' ? req.query.project : '';
    if (!project) return res.status(400).json({ error: 'project required' });
    const templates = await buildInstructionTemplateEditorData(project);
    res.json({ templates });
  });

  return r;
}
