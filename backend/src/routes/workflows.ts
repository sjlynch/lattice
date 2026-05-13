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
  r.post('/api/workflow-runs/:runId/steps/:stepIndex/complete', async (req, res) => {
    const stepIndex = parseInt(req.params.stepIndex, 10);
    if (isNaN(stepIndex)) return res.status(400).json({ error: 'invalid stepIndex' });
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

  return r;
}
