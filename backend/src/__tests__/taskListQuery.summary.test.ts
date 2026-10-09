// The board summary (`buildTaskSummary`, fixtures: helpers/taskListQuery.ts):
// the cheap overview keeps byStatus counts and adds per-lane cost and a
// whole-board total (named boardBytes — `bytes` on every other envelope means
// "this response"), with a hint pointing at the cheap list call and the done
// history.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { approxTokens, buildTaskSummary, jsonBytes } from '../routes/tasks/listQuery.js';
import { META, task } from './helpers/taskListQuery.js';

test('summary keeps byStatus counts and adds per-lane cost + a board total', () => {
  const tasks = [
    task('a', { status: 'open', createdAt: 10 }),
    task('b', { status: 'open', createdAt: 40, description: 'x'.repeat(100) }),
    task('c', { status: 'done', createdAt: 5, doneAt: 99 }),
  ];
  const summary = buildTaskSummary(META, tasks);
  assert.deepEqual(summary.byStatus, { open: 2, done: 1 });
  assert.equal(summary.total, 3);
  assert.equal(summary.lanes.open.count, 2);
  assert.equal(summary.lanes.open.newestActivityAt, 40);
  assert.equal(summary.lanes.done.newestActivityAt, 99);
  // Lane bytes price the FULL records of that lane.
  assert.equal(summary.lanes.open.bytes, jsonBytes(tasks.filter((t) => t.status === 'open')));
  assert.equal(summary.lanes.open.approxTokens, approxTokens(summary.lanes.open.bytes));
  // The whole-board cost is named for what it is, not `bytes` — which on every
  // other envelope means "this response".
  assert.equal(summary.boardBytes, jsonBytes(tasks));
  assert.equal(summary.boardApproxTokens, Math.ceil(summary.boardBytes / 4));
  assert.ok(!('bytes' in summary));
  // Empty lanes stay out of both maps, exactly as byStatus always behaved.
  assert.equal('qa' in summary.lanes, false);
  assert.equal('qa' in summary.byStatus, false);
});

test('summary hint points at the cheap list call and at the done history', () => {
  const tasks = [
    task('a', { status: 'open' }),
    ...Array.from({ length: 5 }, (_, i) => task(`d${i}`, { status: 'done' })),
  ];
  const hint = buildTaskSummary(META, tasks).hint;
  assert.match(hint, /^Active lanes: 1 tasks \(~\d+ B compact\) via GET \/api\/tasks\?project=…\./);
  assert.match(hint, /Done history is 5 tasks \(~\d+ tokens\)/);
  assert.match(hint, /search with GET \/api\/tasks\/search\?q=…\./);
});

test('summary hint drops the history sentence on a board with no done tasks', () => {
  const hint = buildTaskSummary(META, [task('a', { status: 'open' })]).hint;
  assert.match(hint, /^Active lanes: 1 tasks/);
  assert.ok(!hint.includes('Done history'));
});
