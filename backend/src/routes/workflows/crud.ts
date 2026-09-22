// Workflow definition CRUD: list / create / update / delete the stored
// workflow definitions (no run state — see runs.ts for that).

import { Router, type Request, type Response } from 'express';
import {
  createWorkflow,
  deleteWorkflow,
  getWorkflow,
  listWorkflows,
  updateWorkflow,
  type WorkflowStep,
  type WorkflowVariable,
} from '../../workflows.js';
import { readProjectParam, requireOwnedByRequestedProject } from '../projectParam.js';

// `?project=` pin for the by-id routes: a workflow id is looked up across
// every project, so when a project is sent the definition must belong to it
// (404 otherwise, before any write). An unknown id falls through to the
// route's own 404; no project sent → unpinned, as before.
async function workflowInRequestedProject(req: Request<{ id: string }>, res: Response): Promise<boolean> {
  const existing = await getWorkflow(req.params.id);
  if (!existing) return true;
  return requireOwnedByRequestedProject(existing.projectPath, `workflow ${existing.id}`, req, res);
}

export function buildWorkflowCrudRouter(): Router {
  const r = Router();

  r.get('/api/workflows', async (req, res) => {
    const project = readProjectParam(req, res, { source: 'query' });
    if (project === null) return;
    res.json(await listWorkflows(project));
  });

  // A relative project would land the definitions file under the backend's
  // own cwd (`<backend>/<project>/.lattice/workflows.json`); refused.
  r.post('/api/workflows', async (req, res) => {
    const project = readProjectParam(req, res);
    if (project === null) return;
    const { name, steps, variables } = (req.body || {}) as {
      name?: string;
      steps?: WorkflowStep[];
      variables?: WorkflowVariable[];
    };
    if (name !== undefined && typeof name !== 'string') {
      return res.status(400).json({ error: 'name must be a string' });
    }
    if (steps !== undefined && !Array.isArray(steps)) {
      return res.status(400).json({ error: 'steps must be an array' });
    }
    if (variables !== undefined && !Array.isArray(variables)) {
      return res.status(400).json({ error: 'variables must be an array' });
    }
    const w = await createWorkflow(project, name ?? '', steps, variables);
    res.json(w);
  });

  r.patch('/api/workflows/:id', async (req, res) => {
    const updates = (req.body || {}) as {
      name?: string;
      steps?: WorkflowStep[];
      variables?: WorkflowVariable[];
    };
    if (updates.name !== undefined && typeof updates.name !== 'string') {
      return res.status(400).json({ error: 'name must be a string' });
    }
    if (updates.steps !== undefined && !Array.isArray(updates.steps)) {
      return res.status(400).json({ error: 'steps must be an array' });
    }
    if (updates.variables !== undefined && !Array.isArray(updates.variables)) {
      return res.status(400).json({ error: 'variables must be an array' });
    }
    if (!(await workflowInRequestedProject(req, res))) return;
    const w = await updateWorkflow(req.params.id, updates);
    if (!w) return res.status(404).json({ error: 'not found' });
    res.json(w);
  });

  r.delete('/api/workflows/:id', async (req, res) => {
    if (!(await workflowInRequestedProject(req, res))) return;
    const ok = await deleteWorkflow(req.params.id);
    if (!ok) return res.status(404).json({ error: 'not found' });
    res.json({ ok: true });
  });

  return r;
}
