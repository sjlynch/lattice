import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isResumableInterruptedRunLock } from '../recovery/mergeRunResume.js';

// Regression for: "a start → merge → push workflow whose Merge control step was
// killed by a backend restart/crash left its tasks stranded in ready_to_merge
// (never merged), while the next queued workflow started on top." Boot recovery
// resumes a killed `merge-run` lock, but the workflow Merge step holds a
// `workflow-merge:<runId>` lock — which the old label check skipped, so the
// orphaned tasks were never drained.

test('resumes a stale workflow Merge control-step lock', () => {
  assert.equal(isResumableInterruptedRunLock('workflow-merge:wfrun_123_abc'), true);
});

test('resumes a stale workflow Push control-step lock', () => {
  assert.equal(isResumableInterruptedRunLock('workflow-push:wfrun_123_abc'), true);
});

test('still resumes a stale backend merge-run lock (unchanged)', () => {
  assert.equal(isResumableInterruptedRunLock('merge-run'), true);
});

test('does NOT resume a manual /merge lock', () => {
  // A single-task manual merge is not a run; it has its own recovery.
  assert.equal(isResumableInterruptedRunLock('manual-merge'), false);
});

test('does NOT resume a workflow Start lock', () => {
  // Start dies before tasks reach ready_to_merge; its orphans are in_progress
  // and handled by the in-progress sweep, not a merge resume.
  assert.equal(isResumableInterruptedRunLock('workflow-start:wfrun_123_abc'), false);
});
