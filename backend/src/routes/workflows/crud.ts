// Workflow definition CRUD: list / create / update / delete the stored
// workflow definitions (no run state — see runs.ts for that).

import { Router } from 'express';
import {
  createWorkflow,
  deleteWorkflow,
  listWorkflows,
  updateWorkflow,
  type WorkflowStep,
  type WorkflowVariable,
} from '../../workflows.js';

export function buildWorkflowCrudRouter(): Router {
  const r = Router();

  r.get('/api/workflows', async (req, res) => {
    const project = typeof req.query.project === 'string' ? req.query.project : '';
    if (!project) return res.status(400).json({ error: 'project required' });
    res.json(await listWorkflows(project));
  });

  r.post('/api/workflows', async (req, res) => {
    const { project, name, steps, variables } = (req.body || {}) as {
      project?: string;
      name?: string;
      steps?: WorkflowStep[];
      variables?: WorkflowVariable[];
    };
    if (!project) return res.status(400).json({ error: 'project required' });
    const w = await createWorkflow(project, name ?? '', steps, variables);
    res.json(w);
  });

  r.patch('/api/workflows/:id', async (req, res) => {
    const updates = (req.body || {}) as {
      name?: string;
      steps?: WorkflowStep[];
      variables?: WorkflowVariable[];
    };
    const w = await updateWorkflow(req.params.id, updates);
    if (!w) return res.status(404).json({ error: 'not found' });
    res.json(w);
  });

  r.delete('/api/workflows/:id', async (req, res) => {
    const ok = await deleteWorkflow(req.params.id);
    if (!ok) return res.status(404).json({ error: 'not found' });
    res.json({ ok: true });
  });

  return r;
}
