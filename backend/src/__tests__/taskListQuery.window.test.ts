// GET /api/tasks window and order (fixtures: helpers/taskListQuery.ts). since=
// accepts durations, ISO-8601 and epoch milliseconds/seconds — but a short run
// of digits (since=2026) is rejected rather than read as "since 1970", which
// silently matched every task — and filters on lastActivityAt, not createdAt.
// limit defaults to 100 and flags the cut (0 = unlimited, capped at 1000);
// results are newest-first, so the limit keeps the NEWEST tasks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_LIST_LIMIT,
  MAX_LIST_LIMIT,
  buildListOutcome,
  lastActivityAt,
  parseListQuery,
  selectTasks,
  type ListEnvelope,
} from '../routes/tasks/listQuery.js';
import { META, listJson, parse, task } from './helpers/taskListQuery.js';

// ------------------------------------------------------------------ since --

test('since accepts day / hour / minute durations relative to now', () => {
  const now = 1_700_000_000_000;
  assert.equal(parse({ since: '30d' }, now).since, now - 30 * 86_400_000);
  assert.equal(parse({ since: '12h' }, now).since, now - 12 * 3_600_000);
  assert.equal(parse({ since: '45m' }, now).since, now - 45 * 60_000);
});

test('since accepts an ISO-8601 timestamp, epoch milliseconds (13 digits) and epoch seconds (10)', () => {
  assert.equal(parse({ since: '2026-01-01T00:00:00Z' }).since, Date.parse('2026-01-01T00:00:00Z'));
  assert.equal(parse({ since: '1700000000000' }).since, 1_700_000_000_000);
  assert.equal(parse({ since: '1700000000' }).since, 1_700_000_000_000);
});

test('a short run of digits is NOT an epoch — since=2026 must not mean "since 1970"', () => {
  // Read as milliseconds, `2026` is two seconds after the epoch and the filter
  // silently matches every task; `20260901` (a date typed without separators)
  // is the same trap. Both are far more plausible as a year / a date than as a
  // timestamp, so they 400 with the accepted forms instead.
  for (const raw of ['2026', '20260901', '17000000000']) {
    const parsed = parseListQuery({ since: raw });
    assert.equal(parsed.ok, false, `${raw} must be rejected`);
    assert.match(parsed.ok ? '' : parsed.error, /13 digits/);
  }
});

test('an unreadable since is a parse error naming the accepted forms', () => {
  const parsed = parseListQuery({ since: 'last tuesday' });
  assert.equal(parsed.ok, false);
  assert.match(parsed.ok ? '' : parsed.error, /ISO-8601 timestamp, epoch milliseconds.*or a duration/);
});

test('omitted is counted inside the since window, so it answers "what would status=done add HERE"', () => {
  const now = 1_700_000_000_000;
  const tasks = [
    task('a', { status: 'open', createdAt: now }),
    task('recent', { status: 'done', createdAt: now - 86_400_000 }),
    task('ancient', { status: 'done', createdAt: now - 400 * 86_400_000 }),
  ];
  assert.deepEqual(listJson(tasks, { since: '30d' }).omitted, { done: 1, deleted: 0 });
  assert.deepEqual(listJson(tasks).omitted, { done: 2, deleted: 0 });
});

test('since filters on lastActivityAt, not createdAt', () => {
  const now = 1_700_000_000_000;
  const tasks = [
    // Created long ago but touched yesterday — must survive a 7d window.
    task('recent', { createdAt: now - 400 * 86_400_000, updatedAt: now - 86_400_000 }),
    task('stale', { createdAt: now - 400 * 86_400_000 }),
  ];
  const outcome = buildListOutcome(META, tasks, parse({ since: '7d' }, now));
  const body = (outcome as { body: ListEnvelope }).body;
  assert.deepEqual(body.tasks.map((t) => t.id), ['recent']);
  assert.equal(body.matched, 1);
});

test('lastActivityAt takes the newest lifecycle stamp', () => {
  assert.equal(
    lastActivityAt(task('a', { createdAt: 1, updatedAt: 5, startedAt: 3, doneAt: 9 })),
    9,
  );
  assert.equal(lastActivityAt(task('b', { createdAt: 7 })), 7);
});

// ------------------------------------------------------------------ limit --

test('limit defaults to 100 and flags the cut', () => {
  const tasks = Array.from({ length: 150 }, (_, i) => task(`t${i}`, { createdAt: i }));
  const body = listJson(tasks);
  assert.equal(body.count, DEFAULT_LIST_LIMIT);
  assert.equal(body.matched, 150);
  assert.equal(body.truncated, true);
});

test('limit=0 is unlimited and limit caps at 1000', () => {
  const tasks = Array.from({ length: 150 }, (_, i) => task(`t${i}`, { createdAt: i }));
  assert.equal(listJson(tasks, { limit: '0' }).count, 150);
  assert.equal(listJson(tasks, { limit: '150' }).truncated, false);
  assert.equal(parse({ limit: '99999' }).limit, MAX_LIST_LIMIT);
  assert.equal(parse({ limit: '0' }).limit, 0);
});

test('a non-numeric limit is a parse error', () => {
  const parsed = parseListQuery({ limit: 'all' });
  assert.equal(parsed.ok, false);
  assert.match(parsed.ok ? '' : parsed.error, /limit must be a non-negative integer/);
});

// --------------------------------------------------------------- ordering --

test('results are newest-first by lastActivityAt in both fields modes', () => {
  const tasks = [
    task('old', { createdAt: 100 }),
    task('newest', { createdAt: 1, updatedAt: 900 }),
    task('middle', { createdAt: 500 }),
  ];
  assert.deepEqual(listJson(tasks).tasks.map((t) => t.id), ['newest', 'middle', 'old']);
  assert.deepEqual(
    listJson(tasks, { fields: 'full' }).tasks.map((t) => t.id),
    ['newest', 'middle', 'old'],
  );
  // …and the limit therefore keeps the NEWEST tasks, not an arbitrary prefix.
  assert.deepEqual(listJson(tasks, { limit: '1' }).tasks.map((t) => t.id), ['newest']);
});

test('selectTasks does not reorder the caller-supplied array in place', () => {
  const tasks = [task('a', { createdAt: 1 }), task('b', { createdAt: 2 })];
  selectTasks(tasks, parse({ status: 'all' }));
  assert.deepEqual(tasks.map((t) => t.id), ['a', 'b']);
});
