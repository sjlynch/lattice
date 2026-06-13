// Workflow CRUD + run start + step-completion callback.
// Workflow runs are advanced by Stop-hook POSTs to /step-complete —
// not by watching task state.

import { Router } from 'express';
import {
  createWorkflow,
  deleteWorkflow,
  listWorkflows,
  normalizeWorkflowRunHarnessOverride,
  updateWorkflow,
  type WorkflowStep,
} from '../workflows.js';
import {
  getActiveRunsForProject as getActiveWorkflowRunsForProject,
  startWorkflowRun,
  completeWorkflowStep,
  cancelWorkflowRun,
} from '../workflowRuns.js';
import {
  completeWorkflowPromptCustomization,
  getWorkflowPromptCustomization,
  startWorkflowPromptCustomization,
  type WorkflowPromptTemplateId,
} from '../workflowPromptCustomizations.js';
import { workflowStepAgentId } from '../workflowRuns/stepSpawner.js';
import { unregisterAgentSession } from '../agentSessions.js';

export function buildWorkflowsRouter(backendOrigin: string): Router {
  const r = Router();

  r.get('/api/workflows', async (req, res) => {
    const project = typeof req.query.project === 'string' ? req.query.project : '';
    if (!project) return res.status(400).json({ error: 'project required' });
    res.json(await listWorkflows(project));
  });

  r.post('/api/workflows', async (req, res) => {
    const { project, name, steps } = (req.body || {}) as {
      project?: string;
      name?: string;
      steps?: WorkflowStep[];
    };
    if (!project) return res.status(400).json({ error: 'project required' });
    const w = await createWorkflow(project, name ?? '', steps);
    res.json(w);
  });

  r.patch('/api/workflows/:id', async (req, res) => {
    const updates = (req.body || {}) as { name?: string; steps?: WorkflowStep[] };
    const w = await updateWorkflow(req.params.id, updates);
    if (!w) return res.status(404).json({ error: 'not found' });
    res.json(w);
  });

  r.delete('/api/workflows/:id', async (req, res) => {
    const ok = await deleteWorkflow(req.params.id);
    if (!ok) return res.status(404).json({ error: 'not found' });
    res.json({ ok: true });
  });

  r.post('/api/workflows/:id/run', async (req, res) => {
    try {
      const body = req.body || {};
      const rawOverride = body.harnessOverride ?? body.modelOverride ?? null;
      const harnessOverride = normalizeWorkflowRunHarnessOverride(rawOverride);
      if (rawOverride !== null && harnessOverride === null) {
        return res.status(400).json({ error: 'invalid workflow harness override' });
      }
      const run = await startWorkflowRun(req.params.id, backendOrigin, {
        harnessOverride,
      });
      res.json({ run });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // Stop-hook callback fired when a workflow step's Claude session exits.
  // `?source=` tagged by the caller (Claude Stop hook curl, Pi extension
  // fetch, model explicit curl) so a duplicate or out-of-band fire can be
  // traced to its origin in the logs.
  r.post('/api/workflow-runs/:runId/steps/:stepIndex/complete', async (req, res) => {
    const source = typeof req.query.source === 'string' ? req.query.source : 'unknown';
    const stepIndex = parseInt(req.params.stepIndex, 10);
    if (isNaN(stepIndex)) return res.status(400).json({ error: 'invalid stepIndex' });
    console.log(
      `[workflow-step-complete] run=${req.params.runId} step=${stepIndex} source=${source}`,
    );
    // Drop this step's graph node; the next step (if any) registers its own.
    unregisterAgentSession(workflowStepAgentId(req.params.runId, stepIndex));
    await completeWorkflowStep(req.params.runId, stepIndex, backendOrigin);
    res.json({ ok: true });
  });

  r.post('/api/workflow-runs/:runId/cancel', (req, res) => {
    const ok = cancelWorkflowRun(req.params.runId);
    if (!ok) return res.status(404).json({ error: 'run not found or already finished' });
    res.json({ ok: true });
  });

  r.get('/api/workflow-runs/active', (req, res) => {
    const project =
      typeof req.query.project === 'string' ? req.query.project : '';
    if (!project) return res.status(400).json({ error: 'project required' });
    res.json(getActiveWorkflowRunsForProject(project));
  });

  r.post('/api/workflow-prompt-customizations', async (req, res) => {
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
          project: body.project ?? '',
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
