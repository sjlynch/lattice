// Split editing keeps one prompt and operates on custom scopes without mutation.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { toggleStepSplit, mergeArea, renameArea, splitArea, folderAreaOwners, customAreaCounts } from '../components/workflows/splitAreas';
import { buildSourceTree } from '../../../backend/src/shared/sourceAreas';
import type { WorkflowStep, WorkflowRun } from '../api';
import { groupRunSteps } from '../components/workflows/splitRunGroups';
import { stepRunStatus } from '../components/workflows/stepRunStatus';
test('toggle retains the prompt and fields, reverses in one click and ignores control steps', () => {
  const original: WorkflowStep = { id: 'p', title: 'Review', prompt: 'Find {{bugs}}', harness: 'pi', piModel: 'p/m', frozen: true, tools: ['opengrep'] };
  const split = toggleStepSplit(original);
  assert.deepEqual(split, { ...original, split: { mode: 'auto', count: 10 } });
  assert.equal(toggleStepSplit(split).split, undefined); assert.equal(toggleStepSplit(split).prompt, original.prompt);
  assert.equal(original.split, undefined);
  assert.equal(toggleStepSplit({ ...original, kind: 'merge' }).split, undefined);
});
test('rename, merge and split custom paths are immutable and preserve exact coverage', () => {
  const areas = [{ label: 'A', paths: ['src/a', 'src/b'] }, { label: 'B', paths: ['lib'] }];
  const before = structuredClone(areas);
  assert.deepEqual(renameArea(areas, 0, 'Changed')[0], { ...areas[0], label: 'Changed' });
  assert.equal(renameArea(areas, 0, 'x'.repeat(100))[0].label.length, 80);
  assert.deepEqual(mergeArea(areas, 0), [{ label: 'A', paths: ['src/a', 'src/b', 'lib'] }]);
  assert.deepEqual(splitArea(areas, 0).map((a) => a.paths), [['src/a'], ['src/b'], ['lib']]);
  assert.deepEqual(mergeArea(areas, 1), areas); assert.deepEqual(areas, before);
  const tree = buildSourceTree(['src/top.ts', 'src/a/a.ts', 'src/b/b.ts']);
  assert.deepEqual(splitArea([{ label: 'src', paths: ['src'] }], 0, tree).map((a) => a.paths), [['src/*', 'src/a'], ['src/b']]);
  assert.deepEqual(splitArea([{ label: 'flat', paths: ['src/a'] }], 0, tree), [{ label: 'flat', paths: ['src/a'] }]);
});
test('run rows group split members with stable parent title and aggregate status', () => {
  const base: WorkflowStep = { id: 'plain', title: 'Before', prompt: '', harness: 'claude' };
  const steps = [base, ...['a', 'b'].map((label, i) => ({ ...base, id: `p__area${i + 1}`, title: `Review \u00b7 ${label}`, splitOf: 'p', splitArea: { label, paths: [label], files: 4 } }))];
  const run: WorkflowRun = { id: 'r', workflowId: 'wf', workflowName: 'WF', projectPath: '/project', status: 'running', startedAt: 1, currentStepIndex: 1, totalSteps: 3,
    definition: { id: 'wf', name: 'WF', projectPath: '/project', createdAt: 1, variables: [], steps },
    stepStates: { 0: { stepId: 'plain', phase: 'completed' }, 1: { stepId: 'p__area1', phase: 'running' }, 2: { stepId: 'p__area2', phase: 'completed' } } };
  const rows = groupRunSteps(run);
  assert.equal(rows.length, 2); assert.equal(rows[1].title, 'Review'); assert.equal(rows[1].members.length, 2); assert.equal(rows[1].status, 'running');
  assert.equal(stepRunStatus(99, run, false, 'p'), 'running');
  run.stepStates![1].phase = 'errored'; assert.equal(groupRunSteps(run)[1].status, 'error');
  run.stepStates![1].phase = 'completed'; assert.equal(groupRunSteps(run)[1].status, 'done');
});

test('direct-file scopes disable their folder but allow choosing unclaimed child folders', () => {
  const areas = [{ label: 'Top', paths: ['src/*'] }];
  assert.deepEqual(folderAreaOwners('src', areas).map((a) => a.label), ['Top']);
  assert.deepEqual(folderAreaOwners('.', areas).map((a) => a.label), ['Top']);
  assert.deepEqual(folderAreaOwners('src/child', areas), []);
  assert.deepEqual(folderAreaOwners('src', [{ label: 'Child', paths: ['src/child'] }]).map((a) => a.label), ['Child']);
  assert.equal(folderAreaOwners('.', [{ label: 'A', paths: ['a'] }, { label: 'B', paths: ['b'] }]).length, 2);
});

test('custom file counts support duplicate labels and areas dropped by the resolver', () => {
  const areas = [{ label: 'Same', paths: ['missing'] }, { label: 'Same', paths: ['a'] }, { label: 'Same', paths: ['b'] }];
  assert.deepEqual(customAreaCounts(areas, [{ label: 'Same', paths: ['a'], files: 5, weight: 5 }, { label: 'Same', paths: ['b'], files: 9, weight: 9 }]), [0, 5, 9]);
});

test('dropped direct-file scopes do not steal the count of a child folder with the same label', () => {
  const areas = [{ label: 'Same', paths: ['src/*'] }, { label: 'Same', paths: ['src/child'] }];
  const tree = buildSourceTree(['src/top.ts', 'src/child/a.ts']);
  assert.deepEqual(customAreaCounts(areas, [{ label: 'Same', paths: ['src/child'], files: 1, weight: 1 }], tree), [0, 1]);
});
