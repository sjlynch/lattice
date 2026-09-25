import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  saveOptimistic,
  type OptimisticSaveDeps,
} from '../components/taskboard/hooks/optimisticSave.ts';

// Regression for the QA Playwright toggles and the post-merge hook's enable
// switch: a failed settings PATCH left the control on its new value while the
// backend kept the old one (the Globe read "on" but the next QA run spawned
// without Playwright; the hook row read "Off" but the hook still fired).

function makeDeps<T>(
  previous: T,
  persist: (value: T) => Promise<unknown>,
  overrides: Partial<OptimisticSaveDeps<T>> = {},
) {
  const applied: T[] = [];
  const saved: T[] = [];
  const errors: unknown[] = [];
  let settled = 0;
  const deps: OptimisticSaveDeps<T> = {
    persist,
    apply: (value) => applied.push(value),
    isCurrent: () => true,
    previous: () => previous,
    onSaved: (value) => saved.push(value),
    onError: (err) => errors.push(err),
    onSettled: () => settled++,
    ...overrides,
  };
  return { deps, applied, saved, errors, settled: () => settled };
}

const rejectingPatch = () => Promise.reject(new Error('HTTP 500'));

test('a rejected PATCH calls the setter back with the previous value and reports the error', async () => {
  const rec = makeDeps(false, rejectingPatch);
  const ok = await saveOptimistic(true, rec.deps);
  assert.equal(ok, false);
  assert.deepEqual(rec.applied, [true, false], 'shown at once, then reverted');
  assert.equal(rec.errors.length, 1);
  assert.equal((rec.errors[0] as Error).message, 'HTTP 500');
  assert.deepEqual(rec.saved, [], 'a failed save is never recorded as confirmed');
  assert.equal(rec.settled(), 1);
});

test('the new value is applied synchronously, before the PATCH settles', () => {
  const rec = makeDeps(false, () => new Promise(() => {}));
  void saveOptimistic(true, rec.deps);
  assert.deepEqual(rec.applied, [true]);
  assert.equal(rec.settled(), 0, 'still in flight');
});

test('a successful PATCH keeps the new value and records it as confirmed', async () => {
  const rec = makeDeps({ enabled: false, headless: true }, () => Promise.resolve({}));
  const next = { enabled: true, headless: true };
  const ok = await saveOptimistic(next, rec.deps);
  assert.equal(ok, true);
  assert.deepEqual(rec.applied, [next], 'no revert');
  assert.deepEqual(rec.saved, [next]);
  assert.deepEqual(rec.errors, []);
  assert.equal(rec.settled(), 1);
});

test('a superseded save that fails does not revert — the later save owns the UI — but still reports', async () => {
  const rec = makeDeps(false, rejectingPatch, { isCurrent: () => false });
  const ok = await saveOptimistic(true, rec.deps);
  assert.equal(ok, false);
  assert.deepEqual(rec.applied, [true], 'no revert over a newer value / another project');
  assert.equal(rec.errors.length, 1);
  assert.equal(rec.settled(), 1);
});

test('the revert target is read at failure time, so an earlier save that landed meanwhile wins', async () => {
  let confirmed = 'claude';
  let rejectLater!: (err: Error) => void;
  const rec = makeDeps('unused', () => new Promise((_, reject) => (rejectLater = reject)), {
    previous: () => confirmed,
  });
  const pending = saveOptimistic('pi', rec.deps);
  confirmed = 'codex'; // an earlier in-flight save was acknowledged
  rejectLater(new Error('HTTP 502'));
  await pending;
  assert.deepEqual(rec.applied, ['pi', 'codex']);
});
