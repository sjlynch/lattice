import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { WorkflowRun } from '../api';
import { stepRunStatus } from '../components/workflows/stepRunStatus.ts';

function run(over: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    id: 'r',
    workflowId: 'wf',
    workflowName: 'wf',
    projectPath: 'C:/proj',
    status: 'running',
    startedAt: 0,
    totalSteps: 5,
    currentStepIndex: 2,
    ...over,
  };
}

test('no run → every row is unstyled', () => {
  assert.equal(stepRunStatus(0, null), undefined);
  assert.equal(stepRunStatus(0, undefined), undefined);
});

test('running run: before=done, current=running, after=pending', () => {
  const r = run({ status: 'running', currentStepIndex: 2 });
  assert.equal(stepRunStatus(0, r), 'done');
  assert.equal(stepRunStatus(1, r), 'done');
  assert.equal(stepRunStatus(2, r), 'running');
  assert.equal(stepRunStatus(3, r), 'pending');
  assert.equal(stepRunStatus(4, r), 'pending');
});

test('errored run marks the failed step red, prior steps done, later pending', () => {
  const r = run({ status: 'errored', currentStepIndex: 3 });
  assert.equal(stepRunStatus(2, r), 'done');
  assert.equal(stepRunStatus(3, r), 'error');
  assert.equal(stepRunStatus(4, r), 'pending');
});

test('completed run (currentStepIndex advanced past the end) marks all rows done', () => {
  const r = run({ status: 'completed', currentStepIndex: 5, totalSteps: 5 });
  for (let i = 0; i < 5; i++) assert.equal(stepRunStatus(i, r), 'done');
});

test('cancelled run leaves the interrupted step and later steps pending', () => {
  const r = run({ status: 'cancelled', currentStepIndex: 1 });
  assert.equal(stepRunStatus(0, r), 'done');
  assert.equal(stepRunStatus(1, r), 'pending');
  assert.equal(stepRunStatus(2, r), 'pending');
});

test('a frozen row reads as skipped wherever the run index sits', () => {
  const r = run({ status: 'running', currentStepIndex: 2 });
  // The backend walks past frozen steps, so currentStepIndex jumps over them —
  // without the frozen flag row 1 below would be mislabeled `done`.
  assert.equal(stepRunStatus(1, r, true), 'skipped');
  assert.equal(stepRunStatus(3, r, true), 'skipped');
  assert.equal(
    stepRunStatus(4, run({ status: 'completed', currentStepIndex: 5 }), true),
    'skipped',
  );
});

test('frozen rows are unstyled with no run, and beyond the run step count', () => {
  assert.equal(stepRunStatus(0, null, true), undefined);
  assert.equal(stepRunStatus(9, run({ totalSteps: 5 }), true), undefined);
});

test('rows beyond the run step count get no status (workflow edited mid-run)', () => {
  const r = run({ status: 'running', currentStepIndex: 2, totalSteps: 3 });
  assert.equal(stepRunStatus(2, r), 'running');
  assert.equal(stepRunStatus(3, r), undefined);
  assert.equal(stepRunStatus(99, r), undefined);
});
