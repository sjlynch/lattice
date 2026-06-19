import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendSummaryText } from '../routes/tasks/crudHandlers.js';

// `appendSummaryText` is the pure core of POST /api/tasks/:id/append-summary.
// The whole point of the 2026-06-19 change is that the agent summary lands in
// the task's dedicated `summary` field and NEVER touches `description`, so the
// original ticket text the human wrote survives. These cover the stacking /
// trimming behavior in isolation.

test('appendSummaryText: first summary on an empty field is the trimmed text', () => {
  assert.equal(appendSummaryText(undefined, '  done it  '), 'done it');
  assert.equal(appendSummaryText('', 'done it'), 'done it');
  assert.equal(appendSummaryText('   ', 'done it'), 'done it');
});

test('appendSummaryText: second summary stacks below a divider, newest last', () => {
  const first = appendSummaryText(undefined, '- changed A');
  const second = appendSummaryText(first, '- QA passed');
  assert.equal(second, '- changed A\n\n---\n\n- QA passed');
});

test('appendSummaryText: trims each addition but preserves internal newlines', () => {
  const out = appendSummaryText('existing', '\nline 1\nline 2\n');
  assert.equal(out, 'existing\n\n---\n\nline 1\nline 2');
});

test('appendSummaryText: a third append keeps every prior summary', () => {
  let s = appendSummaryText(undefined, 'one');
  s = appendSummaryText(s, 'two');
  s = appendSummaryText(s, 'three');
  assert.equal(s, 'one\n\n---\n\ntwo\n\n---\n\nthree');
});
