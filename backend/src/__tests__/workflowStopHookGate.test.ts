import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  agentQuiescence,
  forgetAgentQuiescence,
  noteAgentSignal,
  noteSubagentStart,
  noteSubagentStop,
} from '../agentQuiescence.js';
import {
  cancelStopHookGate,
  requestStopHookStepComplete,
} from '../workflowRuns/stopHookGate.js';
import { workflowStepAgentId } from '../workflowRuns/sessionSpawner.js';
import { runs, type WorkflowRun } from '../workflowRuns/state.js';

// Regression for: "workflow steps sometimes run in parallel." Claude's Stop
// hook fires early/repeatedly when the step agent uses subagents, so the
// Stop-hook-sourced /complete callback must NOT advance the run until the
// step's session is quiescent (no live subagents + a quiet settle window).

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function seedRun(id: string, currentStepIndex: number): WorkflowRun {
  const run: WorkflowRun = {
    id,
    workflowId: 'wf-x',
    workflowName: 'x',
    projectPath: 'C:/gate-project',
    status: 'running',
    startedAt: 0,
    totalSteps: 3,
    currentStepIndex,
  };
  runs.set(id, run);
  return run;
}

test('agentQuiescence tracks live subagents and clamps at zero', () => {
  const id = 'quiescence-unit';
  try {
    assert.equal(agentQuiescence(id).liveSubagents, 0);
    assert.equal(agentQuiescence(id).quietForMs, Number.POSITIVE_INFINITY, 'unknown agent is quiet');

    noteSubagentStart(id);
    noteSubagentStart(id);
    assert.equal(agentQuiescence(id).liveSubagents, 2);

    noteSubagentStop(id);
    assert.equal(agentQuiescence(id).liveSubagents, 1);

    // Extra stops (missed/duplicate starts) can never drive the count negative.
    noteSubagentStop(id);
    noteSubagentStop(id);
    assert.equal(agentQuiescence(id).liveSubagents, 0);

    noteAgentSignal(id);
    assert.ok(agentQuiescence(id).quietForMs < 50, 'a fresh signal reads as recently active');
  } finally {
    forgetAgentQuiescence(id);
  }
});

test('a failed gated completion retries only after renewed quiescence', async () => {
  const runId = 'gate-retry';
  const agentId = workflowStepAgentId(runId, 0);
  let attempts = 0;
  try {
    seedRun(runId, 0);
    requestStopHookStepComplete(runId, 0, async () => {
      attempts++;
      if (attempts === 1) { noteSubagentStart(agentId); throw new Error('temporary write failure'); }
    }, { settleMs: 10, pollMs: 5 });
    await sleep(70);
    assert.equal(attempts, 1, 'retry must wait while a subagent is live');
    noteSubagentStop(agentId);
    await sleep(70);
    assert.equal(attempts, 2);
  } finally { cancelStopHookGate(runId); forgetAgentQuiescence(agentId); runs.delete(runId); }
});

test('persistent gated completion failure is bounded and visible without killing the run', async () => {
  const runId = 'gate-retry-exhausted';
  let attempts = 0;
  const run = seedRun(runId, 0);
  try {
    requestStopHookStepComplete(runId, 0, async () => { attempts++; throw new Error('disk full'); }, { settleMs: 2, pollMs: 2 });
    await sleep(100);
    assert.equal(attempts, 3);
    assert.equal(run.status, 'running');
    assert.match(run.error!, /3 attempts/);
  } finally { cancelStopHookGate(runId); forgetAgentQuiescence(workflowStepAgentId(runId, 0)); runs.delete(runId); }
});

test('a premature Stop while a subagent is live does not advance until quiescent', async () => {
  const runId = 'gate-premature';
  const agentId = workflowStepAgentId(runId, 0);
  let advanced = 0;
  try {
    seedRun(runId, 0);
    // A subagent is in flight — this is the exact premature-Stop scenario.
    noteSubagentStart(agentId);
    requestStopHookStepComplete(runId, 0, () => { advanced += 1; }, { settleMs: 40, pollMs: 10 });

    // While the subagent is live, no amount of waiting advances the step.
    await sleep(120);
    assert.equal(advanced, 0, 'must not advance while a subagent is still running');

    // Subagent finishes → after the settle window the step advances, once.
    noteSubagentStop(agentId);
    await sleep(160);
    assert.equal(advanced, 1, 'advances once the session goes quiescent');
  } finally {
    cancelStopHookGate(runId);
    forgetAgentQuiescence(agentId);
    runs.delete(runId);
  }
});

test('repeated/duplicate Stops advance the step exactly once', async () => {
  const runId = 'gate-dup';
  const agentId = workflowStepAgentId(runId, 0);
  let advanced = 0;
  try {
    seedRun(runId, 0);
    requestStopHookStepComplete(runId, 0, () => { advanced += 1; }, { settleMs: 40, pollMs: 10 });
    await sleep(15);
    // A second Stop fire for the same step extends the window but starts no
    // second poll loop.
    requestStopHookStepComplete(runId, 0, () => { advanced += 1; }, { settleMs: 40, pollMs: 10 });
    await sleep(160);
    assert.equal(advanced, 1, 'exactly one advance despite two Stop fires');
  } finally {
    cancelStopHookGate(runId);
    forgetAgentQuiescence(agentId);
    runs.delete(runId);
  }
});

test('a late Stop for an already-advanced step is ignored', async () => {
  const runId = 'gate-late';
  const agentId = workflowStepAgentId(runId, 0);
  let advanced = 0;
  try {
    // The run has already moved on to step 1; a straggler Stop for step 0 must
    // not resurrect it.
    seedRun(runId, 1);
    requestStopHookStepComplete(runId, 0, () => { advanced += 1; }, { settleMs: 20, pollMs: 5 });
    await sleep(80);
    assert.equal(advanced, 0, 'a Stop for a non-current step never advances');
  } finally {
    cancelStopHookGate(runId);
    forgetAgentQuiescence(agentId);
    runs.delete(runId);
  }
});

test('cancelStopHookGate stops a pending advance', async () => {
  const runId = 'gate-cancel';
  const agentId = workflowStepAgentId(runId, 0);
  let advanced = 0;
  try {
    seedRun(runId, 0);
    requestStopHookStepComplete(runId, 0, () => { advanced += 1; }, { settleMs: 40, pollMs: 10 });
    await sleep(15);
    cancelStopHookGate(runId);
    await sleep(120);
    assert.equal(advanced, 0, 'a cancelled gate never fires its advance');
  } finally {
    cancelStopHookGate(runId);
    forgetAgentQuiescence(agentId);
    runs.delete(runId);
  }
});
