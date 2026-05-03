// Workflow CRUD + run start. Workflow runs themselves are advanced by the
// in-process advancer in workflowRuns.ts; these endpoints just create/edit
// definitions and kick off new runs.

import { Router } from 'express';
import {
  createWorkflow,
  deleteWorkflow,
  listWorkflows,
  updateWorkflow,
  type WorkflowStep,
} from '../workflows.js';
import {
  getActiveRunsForProject as getActiveWorkflowRunsForProject,
  startWorkflowRun,
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
      const { run, spawn } = await startWorkflowRun(req.params.id, backendOrigin);
      res.json({ run, spawn });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  r.get('/api/workflow-runs/active', (req, res) => {
    const project =
      typeof req.query.project === 'string' ? req.query.project : '';
    if (!project) return res.status(400).json({ error: 'project required' });
    res.json(getActiveWorkflowRunsForProject(project));
  });

  return r;
}
