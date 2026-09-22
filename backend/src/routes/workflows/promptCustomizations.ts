// Workflow prompt-customization routes: spawn a harness to tailor a step
// prompt, poll its status/result, and the harness completion callback.
// Backed by workflowPromptCustomizations.ts.

import { Router } from 'express';
import { readProjectParam } from '../projectParam.js';
import {
  completeWorkflowPromptCustomization,
  getWorkflowPromptCustomization,
  startWorkflowPromptCustomization,
  type WorkflowPromptTemplateId,
} from '../../workflowPromptCustomizations.js';

export function buildWorkflowPromptCustomizationsRouter(backendOrigin: string): Router {
  const r = Router();

  r.post('/api/workflow-prompt-customizations', async (req, res) => {
    // The session's scratch lives under `<project>/.lattice/`, so a relative
    // project is refused before it can resolve under the backend's cwd.
    // Use the VALIDATED (trimmed) value: the raw `body.project` was passed on
    // before, so `" C:\\proj"` passed the absolute check yet reached
    // path.resolve with its leading space — a relative path under the cwd.
    const project = readProjectParam(req, res, { source: 'body' });
    if (project === null) return;
    try {
      const body = (req.body || {}) as {
        project?: string;
        stepTitle?: string;
        prompt?: string;
        templateId?: WorkflowPromptTemplateId;
        templateTitle?: string;
        customInstructions?: string;
        harness?: unknown;
      };
      const request = await startWorkflowPromptCustomization(
        {
          project,
          stepTitle: body.stepTitle,
          prompt: body.prompt ?? '',
          templateId: body.templateId,
          templateTitle: body.templateTitle,
          customInstructions: body.customInstructions,
          harness: body.harness,
        },
        backendOrigin,
      );
      res.json(request);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  r.get('/api/workflow-prompt-customizations/:id', (req, res) => {
    const request = getWorkflowPromptCustomization(req.params.id);
    if (!request) return res.status(404).json({ error: 'not found' });
    res.json(request);
  });

  r.post('/api/workflow-prompt-customizations/:id/complete', async (req, res) => {
    const source = typeof req.query.source === 'string' ? req.query.source : 'unknown';
    const error = typeof req.query.error === 'string' ? req.query.error : undefined;
    const prompt = (req.body || {}).prompt;
    const promptLen = typeof prompt === 'string' ? prompt.length : 0;
    console.log(
      `[workflow-customization-complete] id=${req.params.id} source=${source} promptBytes=${promptLen}` +
        (error ? ` backstop-error=${JSON.stringify(error)}` : ''),
    );
    const request = await completeWorkflowPromptCustomization(req.params.id, prompt);
    if (!request) return res.status(404).json({ error: 'not found' });
    res.json({ ok: true });
  });

  return r;
}
