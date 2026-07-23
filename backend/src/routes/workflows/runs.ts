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
  WorkflowRunConflictError,
} from '../../workflowRuns.js';
import { forgetWorkflowStepSession, workflowStepAgentId } from '../../workflowRuns/stepSpawner.js';
import { requestStopHookStepComplete } from '../../workflowRuns/stopHookGate.js';
import { unregisterAgentSession } from '../../agentSessions.js';
import { forgetAgentQuiescence } from '../../agentQuiescence.js';

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
        // Sequential-queue dispatch asks for an empty slot; the queue requeues
        // on the 409 below. Manual/parallel starts omit the flag.
        requireNoActiveRun: body.requireNoActiveRun === true,
      });
      res.json({ run });
    } catch (err) {
      // A sequential start that lost the race for the single slot is a 409, not
      // a 400 — the frontend queue treats it as "still busy, retry" instead of
      // surfacing an error toast.
      if (err instanceof WorkflowRunConflictError) {
        return res.status(409).json({ error: err.message, code: 'active-run-exists' });
      }
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // Stop-hook callback fired when a workflow step's Claude session exits.
  // `?source=` tagged by the caller (Claude Stop hook curl, Pi extension
  // fetch, model explicit curl) so a duplicate or out-of-band fire can be
  // traced to its origin in the logs.
  r.post('/api/workflow-runs/:runId/steps/:stepIndex/complete', async (req, res) => {
    const source = typeof req.query.source === 'string' ? req.query.source : 'unknown';
    const runId = req.params.runId;
    const stepIndex = parseInt(req.params.stepIndex, 10);
    if (isNaN(stepIndex)) return res.status(400).json({ error: 'invalid stepIndex' });
    console.log(
      `[workflow-step-complete] run=${runId} step=${stepIndex} source=${source}`,
    );

    const agentId = workflowStepAgentId(runId, stepIndex);
    // The actual advance: drop this step's graph node + quiescence state (the
    // next step registers its own), then advance the run. Runs when the
    // completion is genuine — immediately for a model/extension-sourced curl,
    // or once the session goes quiescent for a Stop-hook-sourced one.
    const advance = (): Promise<void> => {
      unregisterAgentSession(agentId);
      forgetWorkflowStepSession(runId, stepIndex);
      forgetAgentQuiescence(agentId);
      return completeWorkflowStep(runId, stepIndex, backendOrigin);
    };

    // Claude's `Stop` hook fires early and repeatedly when the step agent uses
    // subagents (Task tool), so a Stop-sourced completion advanced the run while
    // the step was still working → steps ran in parallel. Gate it on the session
    // going quiescent (stopHookGate.ts). The model's own explicit curl
    // (`model-explicit-curl`) and Pi's `session_shutdown` extension are
    // deliberate end-of-work signals and advance immediately; control steps
    // never reach this route.
    if (source.startsWith('claude-stop-hook')) {
      requestStopHookStepComplete(runId, stepIndex, () => void advance());
      return res.json({ ok: true, gated: true });
    }
    await advance();
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
