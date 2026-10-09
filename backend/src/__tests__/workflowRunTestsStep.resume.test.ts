// Run tests step across a backend restart. Resume policy: a live Run tests
// terminal is re-adopted (never re-dispatched) and its project run lock
// re-taken; a gone one is noted and advanced instead of erroring; one that
// never requested a terminal (skip check / lock wait) runs the worker again.
// The run mirror round-trips stepSummaries and the checkpoint (a non-hex HEAD
// never reaches a git revision range), and the stop-hook gate keeps retrying a
// failing completion checkpoint instead of parking the run.
// Harness: helpers/workflowRunTestsStep.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { completeWorkflowStep } from '../workflowRuns.js';
import { runs, type WorkflowRun } from '../workflowRuns/state.js';
import { createWorkflow } from '../workflows.js';
import { classifyWorkflowRunResume } from '../workflowRuns/resumeDecision.js';
import { hasActiveRunTestsStep, runTestsLockLabel } from '../workflowRuns/testStep/runTestsStep.js';
import { workflowStepDir } from '../workflowRuns/scratchDirectory.js';
import { inspectProjectRunLock } from '../projectRunLock.js';
import { deserializeWorkflowRun, serializeWorkflowRuns } from '../workflowRuns/persistence.js';
import { ORIGIN, setup, sleep, testStep } from './helpers/workflowRunTestsStep.js';

// ---------------------------------------------------------------------------
// Resume policy
// ---------------------------------------------------------------------------

test("resume: a live Run tests terminal is re-adopted (never re-dispatched); a gone one advances instead of erroring", () => {
  const base = { status: 'running' as const, currentStepIndex: 0, definitionStepCount: 2, stepKind: 'test' as const };
  assert.equal(classifyWorkflowRunResume({ ...base, stepSessionAlive: true, stepPhase: 'running' }).action, 'readopt');
  assert.equal(classifyWorkflowRunResume({ ...base, stepSessionAlive: null, stepPhase: 'running' }).action, 'readopt');
  assert.equal(classifyWorkflowRunResume({ ...base, stepSessionAlive: false, stepPhase: 'running' }).action, 'advance');
  assert.equal(classifyWorkflowRunResume({ ...base, stepSessionAlive: false, stepPhase: 'spawning' }).action, 'advance');
  // Never requested a terminal (skip check / lock wait) → run the worker again.
  assert.equal(classifyWorkflowRunResume({ ...base, stepSessionAlive: false, stepPhase: 'pending' }).action, 'redispatch');
  assert.equal(classifyWorkflowRunResume({ ...base, stepSessionAlive: true, stepPhase: 'completing' }).action, 'complete');
  // An ordinary agent step keeps erroring.
  assert.equal(classifyWorkflowRunResume({ ...base, stepKind: 'agent', stepSessionAlive: false, stepPhase: 'running' }).action, 'error');
});

test('the run mirror round-trips stepSummaries and the Run tests checkpoint', () => {
  const run: WorkflowRun = {
    id: 'wfrun_mirror', workflowId: 'wf', workflowName: 'wf', projectPath: os.tmpdir(), status: 'running',
    startedAt: 1, totalSteps: 2, currentStepIndex: 1,
    stepSummaries: { 0: 'all green' },
    testStep: { stepIndex: 1, startHead: 'abcdef1234', spawnedAt: 5 },
  };
  const back = deserializeWorkflowRun(JSON.parse(serializeWorkflowRuns([run])).runs[0]);
  assert.deepEqual(back?.stepSummaries, { 0: 'all green' });
  assert.deepEqual(back?.testStep, { stepIndex: 1, startHead: 'abcdef1234', spawnedAt: 5 });
  const bad = deserializeWorkflowRun({ ...run, testStep: { stepIndex: 1, startHead: '$(rm -rf /)' } });
  assert.equal(bad?.testStep?.startHead, null, 'a non-hex HEAD never reaches a git revision range');
});

// ---------------------------------------------------------------------------
// Restart recovery + the stop-hook gate
// ---------------------------------------------------------------------------

async function persistedTestRun(project: string, phase: WorkflowRun['stepPhase']): Promise<WorkflowRun> {
  const wf = await createWorkflow(project, 'Run tests resume', [testStep({ timeoutMinutes: 5 })]);
  return {
    id: `wfrun_resume_${Math.random().toString(36).slice(2, 8)}`,
    workflowId: wf.id, workflowName: wf.name, projectPath: wf.projectPath, status: 'running',
    startedAt: Date.now(), totalSteps: 1, currentStepIndex: 0, definition: wf, stepPhase: phase,
    testStep: { stepIndex: 0, startHead: 'aaaaaaa1', spawnedAt: Date.now() },
  };
}

test('restart: a Run tests step whose terminal is gone is noted and advanced, not errored', async () => {
  const { resumePersistedRun } = await import('../recovery/workflowRunResume.js');
  const h = await setup();
  try {
    const persisted = await persistedTestRun(h.project, 'running');
    await resumePersistedRun(persisted, [], ORIGIN);
    const run = runs.get(persisted.id)!;
    assert.equal(run.status, 'completed');
    assert.match(run.stepSummaries?.[0] ?? '', /Interrupted: .*did not survive the backend restart/);
    assert.equal(h.calls.writeState.length, 0, 'an interrupted run verified nothing');
  } finally {
    await h.cleanup();
  }
});

test('restart: a live Run tests terminal is re-adopted and its project run lock re-taken', async () => {
  const { resumePersistedRun } = await import('../recovery/workflowRunResume.js');
  const h = await setup();
  try {
    const persisted = await persistedTestRun(h.project, 'running');
    const stepDir = workflowStepDir(persisted.projectPath, persisted.id, 0);
    await resumePersistedRun(persisted, [{ id: 'pty-1', cwd: stepDir }], ORIGIN);
    const run = runs.get(persisted.id)!;
    assert.equal(run.status, 'running');
    assert.equal((await inspectProjectRunLock(run.projectPath))?.holder.label, runTestsLockLabel(run.id));
    assert.equal(hasActiveRunTestsStep(run.id), true);
    await completeWorkflowStep(run.id, 0, ORIGIN);
    assert.equal(run.status, 'completed');
    assert.equal(await inspectProjectRunLock(run.projectPath), null, 'released on advance');
  } finally {
    await h.cleanup();
  }
});

test('stop-hook gate: a Run tests step keeps retrying a failing completion checkpoint instead of parking', async () => {
  const { requestStopHookStepComplete, cancelStopHookGate } = await import('../workflowRuns/stopHookGate.js');
  const { forgetAgentQuiescence } = await import('../agentQuiescence.js');
  const { workflowStepAgentId } = await import('../workflowRuns/sessionSpawner.js');
  const runId = 'gate-run-tests-exhausted';
  const run: WorkflowRun = {
    id: runId, workflowId: 'wf', workflowName: 'wf', projectPath: 'C:/gate-project', status: 'running',
    startedAt: 0, totalSteps: 1, currentStepIndex: 0,
    definition: { id: 'wf', name: 'wf', projectPath: 'C:/gate-project', createdAt: 0, variables: [], steps: [testStep()] },
  };
  runs.set(runId, run);
  let attempts = 0;
  try {
    requestStopHookStepComplete(runId, 0, async () => { attempts++; throw new Error('disk full'); }, { settleMs: 2, pollMs: 2, runTestsRetryMs: 5 });
    await sleep(150);
    assert.ok(attempts > 3, `kept retrying past three attempts (got ${attempts})`);
    assert.equal(run.error, undefined, 'no parked-run error for a Run tests step');
  } finally {
    cancelStopHookGate(runId);
    forgetAgentQuiescence(workflowStepAgentId(runId, 0));
    runs.delete(runId);
  }
});
