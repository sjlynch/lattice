import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveResumeHarness } from '../routes/tasks/resumeTask.js';

// Regression: POST /api/tasks/:id/resume without a `harness` in the body used
// to re-spawn every task under Claude — even one that was run with Pi or
// Codex. It now defaults to the harness recorded on the task at spawn
// (`Task.harness`); `resumeTaskById` then reuses the task's recorded `piModel`
// for a Pi resume. An explicit harness still wins.

test('a body-less resume reuses the task\'s recorded harness', () => {
  assert.equal(resolveResumeHarness(undefined, { harness: 'pi' }), 'pi');
  assert.equal(resolveResumeHarness(undefined, { harness: 'codex' }), 'codex');
  assert.equal(resolveResumeHarness(undefined, { harness: 'claude' }), 'claude');
});

test('an explicit (valid) harness in the body wins over the recorded one', () => {
  assert.equal(resolveResumeHarness('claude', { harness: 'pi' }), 'claude');
  assert.equal(resolveResumeHarness('codex', { harness: 'pi' }), 'codex');
});

test('an invalid/empty requested harness falls back to the recorded one', () => {
  assert.equal(resolveResumeHarness('', { harness: 'codex' }), 'codex');
  assert.equal(resolveResumeHarness('bogus', { harness: 'pi' }), 'pi');
  assert.equal(resolveResumeHarness(null, { harness: 'pi' }), 'pi');
});

test('a task with no recorded harness keeps the Claude default', () => {
  assert.equal(resolveResumeHarness(undefined, {}), 'claude');
  assert.equal(resolveResumeHarness(undefined, { harness: undefined }), 'claude');
});
