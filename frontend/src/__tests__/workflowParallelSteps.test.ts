import { test } from 'node:test';
import assert from 'node:assert/strict';
import React, { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AgentStepHeader } from '../components/workflows/AgentStepHeader';
import { parallelGroupAt, workflowRunProgress } from '../components/workflows/parallelSteps';
import { stepRunStatus } from '../components/workflows/stepRunStatus';
import { clearControlProgressForStep, clearStaleControlProgress, setControlProgress } from '../components/workflows/hooks/workflowRunSync';
import { fromWorkflow } from '../components/workflows/editorState';
import type { WorkflowRun, WorkflowStep } from '../api';
import { installGlobal } from './domDoubles';

// The toggle and rail represent authored adjacency, while live rows report
// each captured member independently, even after editor reordering.
const steps: WorkflowStep[] = [
  { id: 'a', title: 'Review A', prompt: '', harness: 'claude', parallel: true },
  { id: 'b', title: 'Review B', prompt: '', harness: 'claude', parallel: true, frozen: true },
  { id: 'c', title: 'Review C', prompt: '', harness: 'claude', parallel: true },
  { id: 'action', title: 'Merge', prompt: '', harness: 'claude', kind: 'merge', parallel: true },
  { id: 'd', title: 'Review D', prompt: '', harness: 'claude', parallel: true },
];
const run: WorkflowRun = { id: 'r', workflowId: 'wf', workflowName: 'Review', projectPath: '/project',
  status: 'running', startedAt: 1, totalSteps: 5, currentStepIndex: 0, activeStepIndices: [0, 2],
  stepStates: { 0: { stepId: 'a', phase: 'running' }, 1: { stepId: 'b', phase: 'skipped' },
    2: { stepId: 'c', phase: 'completed' }, 3: { stepId: 'action', phase: 'pending' }, 4: { stepId: 'd', phase: 'pending' } } };

test('rail joins adjacent marked reviews including frozen members, and breaks at actions and singletons', () => {
  assert.deepEqual(parallelGroupAt(steps, 0), { start: 0, end: 3 });
  assert.deepEqual(parallelGroupAt(steps, 1), { start: 0, end: 3 });
  assert.equal(parallelGroupAt(steps, 3), null);
  assert.equal(parallelGroupAt(steps, 4), null);
  assert.equal(parallelGroupAt([steps[0], { ...steps[1], parallel: false }, steps[2]], 0), null);
});

test('parallel toggle is accessible, pressed when enabled, and shares the rail color class', (t) => {
  t.after(installGlobal('React', React));
  for (const parallel of [false, true]) {
    const markup = renderToStaticMarkup(createElement(AgentStepHeader, { stepId: 'a', index: 0, collapsed: true,
      title: 'Review', harness: 'claude', frozen: false, parallel,
      harnessAvail: { claude: true, codex: true, pi: true }, piMenu: [], customizing: false,
      onChange: () => {}, onRemove: () => {}, onToggleCollapse: () => {}, onCustomize: () => {} }));
    assert.match(markup, new RegExp(`workflows-step-parallel${parallel ? ' on' : ''}"`));
    assert.match(markup, new RegExp(`aria-label="Run step in parallel" aria-pressed="${parallel}"`));
  }
});

test('member status follows captured step IDs through reordering and uses the frozen run definition', () => {
  assert.equal(stepRunStatus(2, run, true, 'a'), 'running');
  assert.equal(stepRunStatus(0, run, false, 'c'), 'done');
  assert.equal(stepRunStatus(0, run, false, 'b'), 'skipped');
  assert.equal(stepRunStatus(0, run, false, 'new-step'), undefined);
  const queued = { ...run, stepStates: { ...run.stepStates, 0: { stepId: 'a', phase: 'pending' as const } } };
  assert.equal(stepRunStatus(0, queued), 'queued');
  assert.equal(stepRunStatus(3, queued), 'pending');
});

test('run progress counts settled runnable steps and reports queued members independently', () => {
  assert.deepEqual(workflowRunProgress(run), { text: 'Parallel reviews: 1 running, 1 complete', percent: 25 });
  const queued = { ...run, stepStates: { ...run.stepStates, 0: { stepId: 'a', phase: 'pending' as const } } };
  assert.match(workflowRunProgress(queued).text, /0 running, 1 queued, 1 complete/);
});

test('one member spawning clears only its scan progress', () => {
  const a = setControlProgress({}, { runId: 'r', stepIndex: 0, kind: 'agent', current: 0, total: 0, message: 'Scan A', parallel: true });
  const both = setControlProgress(a, { runId: 'r', stepIndex: 2, kind: 'agent', current: 0, total: 0, message: 'Scan C', parallel: true });
  const remaining = clearControlProgressForStep(both, 'r', 0);
  assert.equal(remaining.r.message, 'Scan C');
  assert.equal(clearStaleControlProgress(remaining, 'r', 0, [0, 2]).r.message, 'Scan C');
  assert.deepEqual(clearControlProgressForStep(remaining, 'r', 2), {});
});

test('loading an authored workflow preserves each parallel opt-in', () => {
  const editor = fromWorkflow({ id: 'wf', name: 'Review', projectPath: '/project', createdAt: 1, variables: [], steps });
  assert.equal(editor.steps[0].parallel, true);
  assert.equal(editor.steps[1].parallel, true);
});
