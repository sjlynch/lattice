// Workflow-run lifecycle + callbacks: start a run, the Stop-hook step
// completion callback that advances the run, cancel, and the active-runs
// snapshot. Run state itself lives in workflowRuns.ts; these are the HTTP
// edges into it.

import { Router } from 'express';
import { normalizeWorkflowRunHarnessOverride } from '../../workflows.js';
import {
  getActiveRunsForProject as getActiveWorkflowRunsForProject,
  startWorkflowRun,
  cancelWorkflowRun,
  WorkflowRunConflictError,
  getRun,
  workflowStepCompletionAdvance,
} from '../../workflowRuns.js';
import { waitForWorkflowRecovery } from '../../workflowRuns/recoveryReadiness.js';
import { recordStopReceived, requestStopHookStepComplete } from '../../workflowRuns/stopHookGate.js';
import { readProjectParam, requireOwnedByRequestedProject } from '../projectParam.js';

export function buildWorkflowRunsRouter(backendOrigin: string): Router {
  const r = Router();
  r.use(['/api/workflows/:id/run', '/api/workflow-runs'], async (_req, res, next) => {
    if (!await waitForWorkflowRecovery()) {
      res.setHeader('Retry-After', '2');
      res.status(503).json({ error: 'workflow recovery is still loading; retry this request', code: 'workflow-recovering' });
      return;
    }
    next();
  });

  r.post('/api/workflows/:id/run', async (req, res) => {
    try {
      const body = req.body || {};
      const rawOverride = body.harnessOverride ?? body.modelOverride ?? null;
      const harnessOverride = normalizeWorkflowRunHarnessOverride(rawOverride);
      if (rawOverride !== null && harnessOverride === null) {
        return res.status(400).json({ error: 'invalid workflow harness override' });
      }
      // A body `requireNoActiveRun` (sent by older frontends' sequential queue)
      // is still accepted and ignored: every start now refuses a second active
      // run for the project.
      const run = await startWorkflowRun(req.params.id, backendOrigin, {
        harnessOverride,
        piModelOverride:
          typeof body.piModelOverride === 'string' ? body.piModelOverride : undefined,
      });
      res.json({ run });
    } catch (err) {
      // A start while another run is active for the project is a 409, not a
      // 400 — the frontend queue treats it as "still busy, retry" and a manual
      // ▶ Run enqueues, instead of surfacing an error toast.
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
    if (!/^\d+$/.test(req.params.stepIndex) || !Number.isSafeInteger(stepIndex)) return res.status(400).json({ error: 'invalid stepIndex' });
    if (!getRun(runId)) return res.status(404).json({ error: 'workflow run not found; completion was not applied' });
    console.log(
      `[workflow-step-complete] run=${runId} step=${stepIndex} source=${source}`,
    );

    // The actual advance: drop this step's graph node + quiescence state, KILL
    // its pty, then advance the run. Runs when the completion is genuine —
    // immediately for a model/extension-sourced curl, or once the session goes
    // quiescent for a Stop-hook-sourced one. Killing the finishing step's pty
    // BEFORE dispatching the next step is what reclaims an otherwise-immortal
    // interactive Codex session and prevents step N running alongside step N+1
    // (see killWorkflowStepSession). It's awaited so the teardown completes
    // before the next step spawns; harmless no-op for an already-exited session.
    const advance = workflowStepCompletionAdvance(runId, stepIndex, backendOrigin);

    // Claude's `Stop` hook fires early and repeatedly when the step agent uses
    // subagents (Task tool), so a Stop-sourced completion advanced the run while
    // the step was still working → steps ran in parallel. Gate it on the session
    // going quiescent (stopHookGate.ts). The model's own explicit curl
    // (`model-explicit-curl`) and Pi's `session_shutdown` extension are
    // deliberate end-of-work signals and advance immediately; control steps
    // never reach this route.
    if (source.startsWith('claude-stop-hook')) {
      // Record the Stop durably BEFORE answering: the gate is an in-memory
      // timer, the hook stops retrying once it has its 200, and the agent is
      // idle — a restart inside the settle window would otherwise lose this
      // completion for good. Boot recovery re-arms the gate from the record.
      await recordStopReceived(runId, stepIndex);
      requestStopHookStepComplete(runId, stepIndex, advance);
      return res.json({ ok: true, gated: true });
    }
    await advance();
    res.json({ ok: true });
  });

  r.post('/api/workflow-runs/:runId/cancel', (req, res) => {
    // `?project=` pin (optional): a run id is global, so a caller that names
    // its board can't cancel another board's run. Unknown ids fall through to
    // the 404 below; no project sent → unpinned, as before.
    const run = getRun(req.params.runId);
    if (run && !requireOwnedByRequestedProject(run.projectPath, `workflow run ${run.id}`, req, res)) return;
    const ok = cancelWorkflowRun(req.params.runId);
    if (!ok) return res.status(404).json({ error: 'run not found or already finished' });
    res.json({ ok: true });
  });

  r.get('/api/workflow-runs/active', (req, res) => {
    const project = readProjectParam(req, res, { source: 'query' });
    if (project === null) return;
    res.json(getActiveWorkflowRunsForProject(project));
  });

  // One run by id, including a recently FINISHED one (the registry keeps the
  // last MAX_FINISHED_RUNS_PER_PROJECT per project, never across a restart).
  // The frontend queue asks this when a run leaves its active set without a
  // terminal WS event (missed while its socket was down), so it can tell
  // "completed while I was disconnected" from "lost". 404 = unknown to this
  // process. Registered after `/active` so that path isn't read as an id.
  r.get('/api/workflow-runs/:runId', (req, res) => {
    const run = getRun(req.params.runId);
    if (!run) return res.status(404).json({ error: 'workflow run not found' });
    if (!requireOwnedByRequestedProject(run.projectPath, `workflow run ${run.id}`, req, res)) return;
    res.json({ run });
  });

  return r;
}
