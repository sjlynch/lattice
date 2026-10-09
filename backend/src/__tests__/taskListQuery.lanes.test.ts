// GET /api/tasks lane selection (fixtures: helpers/taskListQuery.ts). The
// default is the ACTIVE lanes, reporting what it omitted; an explicit status
// (a lane, a CSV subset, or all) drops that report. An unknown lane is a parse
// error naming the real ones — a typo used to return 200 with count 0, which
// reads as "that lane is empty" — and a repeated ?status= flattens to the CSV
// the parser reads (dropping it fell back to the default lanes, hiding exactly
// the lanes the caller named). ids= is the EXPAND tier: it bypasses the lane
// filter and since, defaults to full UNCLIPPED fields, is uncapped in request
// order, and reports missing ids.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ACTIVE_STATUSES, parseListQuery } from '../routes/tasks/listQuery.js';
import { stringParams } from '../routes/tasks/crudList.js';
import type { Task } from '../tasks.js';
import { listJson, parse, task } from './helpers/taskListQuery.js';

// ---------------------------------------------------------- status filter --

test('status defaults to the active lanes and reports what it omitted', () => {
  const tasks = [
    task('a', { status: 'open' }),
    task('b', { status: 'in_progress' }),
    task('c', { status: 'done' }),
    task('d', { status: 'done' }),
    task('e', { status: 'deleted' }),
  ];
  const body = listJson(tasks);
  assert.deepEqual(body.tasks.map((t) => t.id).sort(), ['a', 'b']);
  assert.equal(body.count, 2);
  assert.equal(body.matched, 2);
  // `total` stays the whole board so the caller can see it is looking at a slice.
  assert.equal(body.total, 5);
  assert.deepEqual(body.omitted, { done: 2, deleted: 1 });
});

test('the default lane set is exactly ACTIVE_STATUSES', () => {
  const tasks = ACTIVE_STATUSES.map((status, i) => task(`a${i}`, { status }));
  tasks.push(task('done', { status: 'done' }), task('gone', { status: 'deleted' }));
  const body = listJson(tasks);
  assert.deepEqual(
    body.tasks.map((t) => t.status).sort(),
    [...ACTIVE_STATUSES].sort(),
  );
});

test('explicit status=done includes history and drops the omitted report', () => {
  const tasks = [task('a', { status: 'open' }), task('c', { status: 'done' })];
  const body = listJson(tasks, { status: 'done' });
  assert.deepEqual(body.tasks.map((t) => t.id), ['c']);
  // `omitted` is a "you asked for the default" signal; an explicit filter means
  // the caller already knows what it excluded.
  assert.equal(body.omitted, undefined);
  assert.ok(!(body.hint ?? '').includes('omitted by default'));
});

test('status=all returns every lane with no omitted report', () => {
  const tasks = [
    task('a', { status: 'open' }),
    task('c', { status: 'done' }),
    task('e', { status: 'deleted' }),
  ];
  const body = listJson(tasks, { status: 'all' });
  assert.equal(body.count, 3);
  assert.equal(body.omitted, undefined);
});

test('status accepts a CSV lane subset', () => {
  const tasks = [
    task('a', { status: 'open' }),
    task('b', { status: 'in_progress' }),
    task('c', { status: 'qa' }),
  ];
  const body = listJson(tasks, { status: 'open, in_progress' });
  assert.deepEqual(body.tasks.map((t) => t.id).sort(), ['a', 'b']);
});

test('an unknown lane is a parse error naming the real ones — not a silently empty board', () => {
  // The list is now an agent's primary interface with a free-string `status`.
  // A typo (`in-progress`, `ready`) used to return 200 with count 0, which
  // reads as "that lane is empty" — the one conclusion it must not lead to.
  const parsed = parseListQuery({ status: 'open,in-progress' });
  assert.equal(parsed.ok, false);
  assert.match(parsed.ok ? '' : parsed.error, /status must be one of: backlog, open, in_progress/);
  assert.match(parsed.ok ? '' : parsed.error, /"in-progress"/);
  // `all` is accepted in any case, like `fields`.
  assert.equal(parse({ status: 'ALL' }).statuses, null);
  assert.equal(parse({ status: 'All' }).statusLabel, 'all');
});

test('a repeated query param (?status=open&status=qa) flattens to the CSV the parser reads', () => {
  // Express delivers a repeated param as an array. Dropping it (the old
  // string-only flatten) fell back to the DEFAULT lanes — silently hiding
  // exactly the lanes the caller had named twice over.
  const flat = stringParams({ project: 'C:/p', status: ['open', 'qa'], limit: '5' } as never);
  assert.deepEqual(flat, { project: 'C:/p', status: 'open,qa', limit: '5' });
  assert.deepEqual([...(parse(flat).statuses ?? [])], ['open', 'qa']);
  // A nested object is not a string list; it is left for the parser to default.
  assert.deepEqual(stringParams({ status: { nested: 'x' } } as never), {});
});

// ------------------------------------------------------------- ids mode --

test('ids bypasses the lane filter, defaults to full UNCLIPPED fields, and reports missing', () => {
  const long = 'the done one '.repeat(60); // ~780 chars, over the 500 default clip
  const tasks = [
    task('a', { status: 'done', description: long }),
    task('b', { status: 'open' }),
  ];
  const body = listJson(tasks, { ids: 'a,nope' });
  // `a` is in a lane the default filter would have dropped — addressing a task
  // by id must never be second-guessed by a lane default.
  assert.deepEqual(body.tasks.map((t) => t.id), ['a']);
  assert.equal(body.fields, 'full');
  // ids= is the EXPAND tier: the text comes back whole. (The clipped-text hint
  // sends callers to `?ids=` for full text — if this clipped too, that hint
  // would loop.)
  assert.equal((body.tasks[0] as Task).description, long);
  assert.equal(body.clipped, 0);
  assert.deepEqual(body.missing, ['nope']);
  assert.equal(body.omitted, undefined);
  // An explicit clip is still honoured in ids mode.
  const clipped = listJson(tasks, { ids: 'a', clip: '10' });
  assert.equal(clipped.clipped, 1);
});

test('ids mode ignores since — a named task is never silently dropped', () => {
  const now = 1_700_000_000_000;
  const stale = task('a', { createdAt: now - 400 * 86_400_000 });
  const body = listJson([stale], { ids: 'a', since: '30d' });
  assert.deepEqual(body.tasks.map((t) => t.id), ['a']);
  assert.equal(body.missing, undefined);
});

test('ids mode omits `missing` when every id resolved', () => {
  const body = listJson([task('a'), task('b')], { ids: 'a,b' });
  assert.equal(body.missing, undefined);
  assert.equal(body.count, 2);
});

test('ids mode still honors an explicit fields=compact', () => {
  const body = listJson([task('a', { description: 'x' })], { ids: 'a', fields: 'compact' });
  assert.equal(body.fields, 'compact');
  assert.equal((body.tasks[0] as { description?: string }).description, undefined);
});

test('ids mode is uncapped and keeps request order — 150 ids come back, as asked', () => {
  // Activity order is t0 (oldest) … t149 (newest); request a shuffle of it that
  // is neither, so a newest-first sort or a 100-task default would both show.
  const tasks = Array.from({ length: 150 }, (_, i) => task(`t${i}`, { createdAt: i }));
  const requested = tasks.map((t) => t.id).sort((a, b) => (a.length - b.length) || b.localeCompare(a));
  const body = listJson(tasks, { ids: requested.join(',') });
  assert.equal(body.count, 150);
  assert.equal(body.truncated, false);
  assert.deepEqual(body.tasks.map((t) => t.id), requested);
  assert.equal(parse({ ids: 'a' }).limit, 0);
});

test('ids mode: an explicit limit cuts the tail of the request, and duplicates collapse', () => {
  const tasks = [task('a', { createdAt: 1 }), task('b', { createdAt: 2 }), task('c', { createdAt: 3 })];
  const body = listJson(tasks, { ids: 'a,c,a,b', limit: '2' });
  assert.deepEqual(body.tasks.map((t) => t.id), ['a', 'c']);
  assert.equal(body.matched, 3);
  assert.equal(body.truncated, true);
  assert.match(body.hint ?? '', /first 2 of 3 requested tasks \(request order\)/);
});
