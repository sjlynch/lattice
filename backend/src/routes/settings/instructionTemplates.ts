// GET /api/instruction-templates — the editable agent instruction templates
// for a project: each template's default markdown, the project's current
// (override-or-default) text, and its `{{token}}` docs. Backs the settings
// dialog's "Agent prompts" tab. Edits are saved back through PATCH
// /api/settings (`instructionTemplateOverrides`). Read-only.

import { Router } from 'express';
import { buildInstructionTemplateEditorData } from '../../instructionTemplates.js';
import { readProjectParam } from '../projectParam.js';

export function buildInstructionTemplatesRouter(): Router {
  const r = Router();

  r.get('/api/instruction-templates', async (req, res) => {
    const project = readProjectParam(req, res, { source: 'query' });
    if (project === null) return;
    const templates = await buildInstructionTemplateEditorData(project);
    res.json({ templates });
  });

  return r;
}
