import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseVerdictBody } from '../routes/qaRuns.js';
import { renderQaInstructions } from '../qaRuns/instructions.js';
import {
  applyQaVerdict,
  forgetQaRun,
  getQaRun,
  markQaRunDone,
  recordQaRun,
} from '../qaRuns.js';

// ---------- parseVerdictBody ----------
//
// This is the LLM-facing edge of the QA auto-advance: the agent hand-builds the
// JSON body for POST /api/qa-runs/:id/verdict. Only a confident PASS should
// read back as passed+confident (the one combination that promotes qa → done).

test('parseVerdictBody: confident pass', () => {
  assert.deepEqual(parseVerdictBody({ verdict: 'pass', confidence: 'high' }), {
    passed: true,
    confident: true,
  });
});

test('parseVerdictBody: pass but low confidence does not auto-advance', () => {
  assert.deepEqual(parseVerdictBody({ verdict: 'pass', confidence: 'low' }), {
    passed: true,
    confident: false,
  });
});

test('parseVerdictBody: fail is never confident-pass', () => {
  assert.deepEqual(parseVerdictBody({ verdict: 'fail', confidence: 'high' }), {
    passed: false,
    confident: true,
  });
});

test('parseVerdictBody: tolerates case / whitespace / "passed"', () => {
  assert.deepEqual(parseVerdictBody({ verdict: ' PASSED ', confidence: ' HIGH ' }), {
    passed: true,
    confident: true,
  });
});

test('parseVerdictBody: boolean shorthand', () => {
  assert.deepEqual(parseVerdictBody({ passed: true, confident: true }), {
    passed: true,
    confident: true,
  });
});

test('parseVerdictBody: empty / garbage body is a non-confident non-pass', () => {
  assert.deepEqual(parseVerdictBody(undefined), { passed: false, confident: false });
  assert.deepEqual(parseVerdictBody({}), { passed: false, confident: false });
  assert.deepEqual(parseVerdictBody({ verdict: 'maybe' }), {
    passed: false,
    confident: false,
  });
});

// ---------- renderQaInstructions ----------
//
// The brief must hand the agent a verdict URL keyed by the run id, and tell it
// the confident-PASS-auto-advances rule, or the agent never reports the verdict
// that closes the QA → Done step.

test('renderQaInstructions: embeds the run-keyed verdict URL + auto-advance step', () => {
  const md = renderQaInstructions({
    projectPath: 'C:/dev/proj',
    qaRunId: 'qa_run_123',
    taskId: 't_abc',
    taskTitle: 'My feature',
    taskDescription: 'Does a thing',
    backendOrigin: 'http://127.0.0.1:5184',
  });
  assert.match(md, /http:\/\/127\.0\.0\.1:5184\/api\/qa-runs\/qa_run_123\/verdict/);
  assert.match(md, /http:\/\/127\.0\.0\.1:5184\/api\/tasks\/t_abc\/append-summary/);
  assert.match(md, /confident PASS auto-moves the task to Done/);
  // No unsubstituted tokens left behind.
  assert.doesNotMatch(md, /\{\{\s*\w+\s*\}\}/);
});

// ---------- forgetQaRun guard ----------
//
// Regression guard for the "passed task stuck in QA" bug: the frontend status
// poller forgets a run (DELETE /api/qa-runs/:id) on any failed poll, including
// a transient one. If that dropped a still-running run, the agent's later
// verdict would land as `tracked:false` and never advance qa → done. So forget
// must refuse to drop a `running` run, and only finalize a `done` one.

function makeRunningRun(id: string) {
  recordQaRun({
    id,
    taskId: 't_does_not_exist',
    projectPath: 'C:/dev/proj',
    cwd: `C:/dev/proj/.scratch/${id}`,
    status: 'running',
    createdAt: 1,
  });
}

test('forgetQaRun: keeps a still-running run so its verdict can still advance it', async () => {
  const id = 'qa_test_running_keep';
  makeRunningRun(id);
  // The frontend poller's transient-failure DELETE must NOT drop a live run.
  forgetQaRun(id);
  assert.ok(getQaRun(id), 'a running run must survive forgetQaRun');

  // A verdict arriving afterward is still tracked (the move itself no-ops only
  // because the throwaway task id does not exist — the point is tracked:true,
  // not the silent tracked:false that caused the stuck-in-QA bug).
  const outcome = await applyQaVerdict(id, { passed: true, confident: true });
  assert.equal(outcome.tracked, true);
  // Tidy up the module-global registry: only a done run can be forgotten.
  markQaRunDone(id);
  forgetQaRun(id);
});

test('forgetQaRun: drops a run once it is marked done', () => {
  const id = 'qa_test_done_drop';
  makeRunningRun(id);
  markQaRunDone(id);
  forgetQaRun(id);
  assert.equal(getQaRun(id), undefined, 'a done run is forgotten normally');
});
