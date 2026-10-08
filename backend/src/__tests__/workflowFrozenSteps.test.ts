import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { completeWorkflowStep, startWorkflowRun } from '../workflowRuns.js';
import { runs } from '../workflowRuns/state.js';
import { createWorkflow } from '../workflows.js';
import { normalizeSteps } from '../workflows/normalization.js';
import type { WorkflowStep } from '../workflows.js';

// The editor's snowflake toggle sets `WorkflowStep.frozen`; the run engine must
// then walk straight past that step (`nextStepGroup` in workflowRuns/execution.ts).
// These pin the flag's coercion and the two places the run engine honours it
// (run start and step advance).

function step(over: Partial<WorkflowStep> = {}): WorkflowStep {
  return {
    id: `s${Math.random().toString(36).slice(2, 7)}`,
    title: 'Step',
    prompt: 'do a thing',
    mode: 'sequential',
    harness: 'claude',
    ...over,
  };
}

const ORIGIN = 'http://127.0.0.1:5184';

test('only a literal true freezes a step', () => {
  // Untrusted disk/HTTP input is coerced the same way, and a not-frozen step
  // keeps the flag out of the JSON entirely (undefined, not false).
  const [truthyGarbage, real, plain] = normalizeSteps([
    { title: 'a', frozen: 'yes' },
    { title: 'b', frozen: true },
    { title: 'c' },
  ]);
  assert.equal(truthyGarbage.frozen, undefined);
  assert.equal(real.frozen, true);
  assert.equal(plain.frozen, undefined);
  assert.equal('frozen' in JSON.parse(JSON.stringify(plain)), false);
});

test('a run refuses to start when every step is frozen', async () => {
  const project = await fs.mkdtemp(path.join(os.tmpdir(), 'lattice-wffrozen-'));
  let canonical = '';
  try {
    const wf = await createWorkflow(project, 'All frozen', [
      step({ id: 's1', frozen: true }),
      step({ id: 's2', frozen: true }),
    ]);
    canonical = wf.projectPath;

    // Refused rather than silently "completing" instantly — an empty-looking
    // run in the strip reads as a broken Run button.
    await assert.rejects(
      () => startWorkflowRun(wf.id, ORIGIN),
      /every step in this workflow is frozen/,
    );
    // And the rejection is side-effect-free: no run record was left behind.
    assert.equal([...runs.values()].some((r) => r.workflowId === wf.id), false);
  } finally {
    for (const [id, r] of [...runs.entries()]) {
      if (r.projectPath === canonical) runs.delete(id);
    }
    await new Promise((r) => setTimeout(r, 200)); // let the workflow store flush
    await fs.rm(project, { recursive: true, force: true });
  }
});

test('advancing onto trailing frozen steps completes the run instead of spawning them', async () => {
  const project = await fs.mkdtemp(path.join(os.tmpdir(), 'lattice-wffrozen-'));
  let canonical = '';
  try {
    const wf = await createWorkflow(project, 'Freeze the tail', [
      step({ id: 's1' }),
      step({ id: 's2', frozen: true }),
      step({ id: 's3', frozen: true }),
    ]);
    canonical = wf.projectPath;

    // Stand in for a run parked on step 0 (no pty needed — this exercises the
    // advance path, which is where the skip decision is made).
    runs.set('wfrun_frozen_tail', {
      id: 'wfrun_frozen_tail',
      workflowId: wf.id,
      workflowName: wf.name,
      projectPath: wf.projectPath,
      status: 'running',
      startedAt: 1_700_000_000_000,
      totalSteps: 3,
      currentStepIndex: 0,
    });

    // Step 0's agent finishes. Steps 1 and 2 are frozen, so nothing is spawned
    // and the run finishes here rather than hanging on a step that never runs.
    await completeWorkflowStep('wfrun_frozen_tail', 0, ORIGIN);
    const run = runs.get('wfrun_frozen_tail');
    assert.equal(run?.status, 'completed');
    // Parked past the last step so every editor row reads as finished.
    assert.equal(run?.currentStepIndex, 3);
  } finally {
    runs.delete('wfrun_frozen_tail');
    for (const [id, r] of [...runs.entries()]) {
      if (r.projectPath === canonical) runs.delete(id);
    }
    await new Promise((r) => setTimeout(r, 200)); // let the workflow store flush
    await fs.rm(project, { recursive: true, force: true });
  }
});
