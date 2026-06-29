// Workflow-run lifecycle + callbacks: start a run, the Stop-hook step
// completion callback that advances the run, cancel, and the active-runs
// snapshot. Run state itself lives in workflowRuns.ts; these are the HTTP
// edges into it.

import { Router } from 'express';
import { normalizeWorkflowRunHarnessOverride } from '../../workflows.js';
import {
  getActiveRunsForProject as getActiveWorkflowRunsForProject,
  startWorkflowRun,
  completeWorkflowStep,
  cancelWorkflowRun,
} from '../../workflowRuns.js';
import { forgetWorkflowStepSession, workflowStepAgentId } from '../../workflowRuns/stepSpawner.js';
import { unregisterAgentSession } from '../../agentSessions.js';

export function buildWorkflowRunsRouter(backendOrigin: string): Router {
  const r = Router();

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
        piModelOverride:
          typeof body.piModelOverride === 'string' ? body.piModelOverride : undefined,
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
    forgetWorkflowStepSession(req.params.runId, stepIndex);
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
