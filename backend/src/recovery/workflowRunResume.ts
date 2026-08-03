// Boot-time resume for workflow runs interrupted by a backend restart.
//
// Sibling of `mergeRunResume.ts`, and for the same underlying reason: a run
// executes inside the backend process, and that process gets restarted
// routinely (`tsc -w` + the dev runner on any `backend/src` change, a crash,
// a processGuards fail-fast). `scripts/dev.mjs` defers a restart only while a
// per-project `run.lock` is held — which a workflow holds during CONTROL steps
// (start/merge/push) and NOT during agent steps. So the exposure window is the
// whole of every agent step, routinely 20+ minutes each.
//
// Before this module, that window silently destroyed the run:
//   1. `GET /api/workflow-runs/active` returned [] → the navbar chip vanished.
//   2. The step's agent kept working (its pty lives in the detached
//      terminal-server, which survives the restart) and eventually POSTed
//      `/api/workflow-runs/<id>/steps/<n>/complete`. `completeWorkflowStep`
//      found no run and returned silently — so the remaining steps (Start all
//      open tasks / Merge all / Push) never ran, with no error anywhere.
//
// `workflowRuns/persistence.ts` now mirrors every running run to
// `~/.lattice/per-project/<hash>/workflow-runs.json`; this reads that mirror on
// boot and applies `classifyWorkflowRunResume`'s decision per run. Runs AFTER
// the HTTP server is listening — a redispatched control step spawns agents that
// curl back into the API.

import { getWorkflow } from '../workflows.js';
import {
  failWorkflowRun,
  getRun,
  redispatchCurrentWorkflowStep,
  restoreWorkflowRun,
} from '../workflowRuns.js';
import { loadPersistedWorkflowRuns } from '../workflowRuns/persistence.js';
import {
  classifyWorkflowRunResume,
  findStepSessionId,
  type ProbedSession,
} from '../workflowRuns/resumeDecision.js';
import { workflowStepDir } from '../workflowRuns/scratchDirectory.js';
import {
  adoptWorkflowStepSession,
  workflowStepAgentId,
} from '../workflowRuns/sessionSpawner.js';
import { effectiveStepHarness } from '../workflowRuns/stepMarkdown.js';
import { registerAgentSession } from '../agentSessions.js';
import { proxyListSessionsOrNull } from '../terminalServerClient.js';
import type { WorkflowRun } from '../workflowRuns/state.js';
import { forEachKnownProjectSafely } from './projectIteration.js';

export async function resumeInterruptedWorkflowRuns(backendOrigin: string): Promise<void> {
  // One terminal-server probe for the whole sweep. `null` means "couldn't
  // ask" — NOT "no sessions" — and the classifier treats it as such so a
  // wedged terminal-server can't mass-error every healthy run.
  const sessions = (await proxyListSessionsOrNull()) as ProbedSession[] | null;

  await forEachKnownProjectSafely('resumeInterruptedWorkflowRuns', async (repoRoot) => {
    const persisted = await loadPersistedWorkflowRuns(repoRoot);
    for (const run of persisted) {
      await resumePersistedRun(run, sessions, backendOrigin);
    }
  });
}

async function resumePersistedRun(
  run: WorkflowRun,
  sessions: ProbedSession[] | null,
  backendOrigin: string,
): Promise<void> {
  if (getRun(run.id)) return; // already live in this process — nothing to resume

  const wf = await getWorkflow(run.workflowId).catch(() => null);
  const step = wf?.steps[run.currentStepIndex] ?? null;
  const stepDir = workflowStepDir(run.projectPath, run.id, run.currentStepIndex);
  const serverId = sessions ? findStepSessionId(sessions, stepDir) : null;

  const decision = classifyWorkflowRunResume({
    status: run.status,
    currentStepIndex: run.currentStepIndex,
    definitionStepCount: wf ? wf.steps.length : null,
    stepKind: step ? (step.kind ?? 'agent') : null,
    stepSessionAlive: sessions === null ? null : serverId !== null,
  });

  const label = `${run.id} "${run.workflowName}" step ${run.currentStepIndex + 1}/${run.totalSteps}`;
  if (decision.action === 'skip') return;

  if (decision.action === 'error') {
    // Restore first so the errored run actually reaches the UI (a run that was
    // never restored has nothing to mark errored, and the user would just see
    // it silently gone again).
    restoreWorkflowRun(run);
    console.warn(`[startup] workflow run ${label} cannot be resumed: ${decision.reason}`);
    failWorkflowRun(run.id, `interrupted by a backend restart — ${decision.reason}`);
    return;
  }

  restoreWorkflowRun(run);

  if (decision.action === 'redispatch') {
    console.warn(`[startup] workflow run ${label} interrupted — ${decision.reason}; re-running it.`);
    await redispatchCurrentWorkflowStep(run.id, backendOrigin).catch((err) =>
      console.error(`[startup] workflow run ${run.id}: redispatch failed:`, err),
    );
    return;
  }

  // readopt: the agent is still working. Re-attach its pty so the advance can
  // reclaim it, and put its presence node back on the graph.
  console.log(`[startup] workflow run ${label} re-adopted — ${decision.reason}.`);
  if (serverId) adoptWorkflowStepSession(run.id, run.currentStepIndex, serverId);
  if (wf && step && effectiveStepHarness(wf, run, run.currentStepIndex) === 'claude') {
    registerAgentSession({
      agentId: workflowStepAgentId(run.id, run.currentStepIndex),
      projectPath: run.projectPath,
      label: `workflow step ${run.currentStepIndex + 1}`,
    });
  }
}
