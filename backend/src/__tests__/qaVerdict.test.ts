import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseVerdictBody } from '../routes/qaRuns.js';
import { renderQaInstructions } from '../qaRuns/instructions.js';

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
