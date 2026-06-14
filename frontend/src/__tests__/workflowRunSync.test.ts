import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { WorkflowRun } from '../api';
import {
  activeRunsFromHello,
  addRecentRun,
  clearStaleControlProgress,
  mergeFetchedActiveRuns,
  recentDismissalDelayMs,
  removeKey,
  setControlProgress,
  upsertRun,
  COMPLETED_LINGER_MS,
  ERRORED_LINGER_MS,
  type ControlProgressMap,
  type RunMap,
} from '../components/workflows/hooks/workflowRunSync.ts';

function run(id: string, over: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    id,
    workflowId: `wf-${id}`,
    workflowName: `wf ${id}`,
    projectPath: 'C:/proj',
    status: 'running',
    startedAt: 0,
    totalSteps: 3,
    currentStepIndex: 0,
    ...over,
  };
}

// ---------- activeRunsFromHello ----------

test('activeRunsFromHello builds a keyed map (authoritative replacement)', () => {
  const map = activeRunsFromHello([run('a'), run('b')]);
  assert.deepEqual(Object.keys(map).sort(), ['a', 'b']);
  assert.equal(map.a.id, 'a');
});

test('activeRunsFromHello returns an empty map for no runs', () => {
  assert.deepEqual(activeRunsFromHello([]), {});
});

// ---------- upsertRun ----------

test('upsertRun adds and overwrites by id', () => {
  const r1 = run('a', { currentStepIndex: 0 });
  const m1 = upsertRun({}, r1);
  assert.equal(m1.a.currentStepIndex, 0);
  const m2 = upsertRun(m1, run('a', { currentStepIndex: 2 }));
  assert.equal(m2.a.currentStepIndex, 2);
  assert.notEqual(m1, m2); // new reference
});

// ---------- removeKey ----------

test('removeKey deletes a present key and clones', () => {
  const cur: RunMap = { a: run('a'), b: run('b') };
  const next = removeKey(cur, 'a');
  assert.deepEqual(Object.keys(next), ['b']);
  assert.notEqual(cur, next);
});

test('removeKey returns the same reference when the key is absent', () => {
  const cur: RunMap = { a: run('a') };
  assert.strictEqual(removeKey(cur, 'missing'), cur);
});

// ---------- addRecentRun ----------

test('addRecentRun stashes a finalized run', () => {
  const next = addRecentRun({}, run('a', { status: 'errored' }));
  assert.equal(next.a.status, 'errored');
});

// ---------- clearStaleControlProgress ----------

test('clearStaleControlProgress drops progress when the step advanced', () => {
  const cur: ControlProgressMap = {
    a: { stepIndex: 1, kind: 'start', current: 1, total: 3 },
  };
  const next = clearStaleControlProgress(cur, 'a', 2);
  assert.deepEqual(next, {});
});

test('clearStaleControlProgress is a no-op when the step is unchanged', () => {
  const cur: ControlProgressMap = {
    a: { stepIndex: 1, kind: 'start', current: 1, total: 3 },
  };
  assert.strictEqual(clearStaleControlProgress(cur, 'a', 1), cur);
});

test('clearStaleControlProgress is a no-op when nothing is tracked', () => {
  const cur: ControlProgressMap = {};
  assert.strictEqual(clearStaleControlProgress(cur, 'a', 5), cur);
});

// ---------- setControlProgress ----------

test('setControlProgress records the latest snapshot for a run', () => {
  const next = setControlProgress(
    {},
    {
      runId: 'a',
      stepIndex: 0,
      kind: 'merge',
      current: 2,
      total: 5,
      message: 'merging',
    },
  );
  assert.deepEqual(next.a, {
    stepIndex: 0,
    kind: 'merge',
    current: 2,
    total: 5,
    message: 'merging',
  });
});

// ---------- mergeFetchedActiveRuns ----------

test('mergeFetchedActiveRuns adds only runs not already tracked', () => {
  const cur: RunMap = { a: run('a') };
  const { next, addedIds } = mergeFetchedActiveRuns(cur, {}, [
    run('a'),
    run('b'),
  ]);
  assert.deepEqual(addedIds, ['b']);
  assert.deepEqual(Object.keys(next).sort(), ['a', 'b']);
});

test('mergeFetchedActiveRuns never resurrects a run already in recent', () => {
  const recent: RunMap = { b: run('b', { status: 'completed' }) };
  const { next, addedIds } = mergeFetchedActiveRuns({}, recent, [run('b')]);
  assert.deepEqual(addedIds, []);
  assert.deepEqual(next, {});
});

test('mergeFetchedActiveRuns does not mutate the input map', () => {
  const cur: RunMap = { a: run('a') };
  mergeFetchedActiveRuns(cur, {}, [run('b')]);
  assert.deepEqual(Object.keys(cur), ['a']);
});

// ---------- recentDismissalDelayMs ----------

test('recentDismissalDelayMs lingers completed runs briefly and failures long', () => {
  assert.equal(recentDismissalDelayMs('completed'), COMPLETED_LINGER_MS);
  assert.equal(recentDismissalDelayMs('errored'), ERRORED_LINGER_MS);
  assert.equal(recentDismissalDelayMs('cancelled'), ERRORED_LINGER_MS);
});
