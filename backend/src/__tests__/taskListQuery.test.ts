import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ACTIVE_STATUSES,
  DEFAULT_CLIP_CHARS,
  DEFAULT_LIST_LIMIT,
  LIST_RESPONSE_CEILING_BYTES,
  MAX_LIST_LIMIT,
  approxTokens,
  buildListEnvelopeJson,
  buildListOutcome,
  buildTaskSummary,
  compactTask,
  jsonBytes,
  lastActivityAt,
  parseListQuery,
  selectTasks,
  type ListEnvelope,
  type ListEnvelopeMeta,
  type ListQuery,
  type TooLargeBody,
} from '../routes/tasks/listQuery.js';
import { stringParams } from '../routes/tasks/crudList.js';
import { parseMarkdownDoc } from '../routes/tasks/markdownBatch.js';
import type { Task, TaskStatus } from '../tasks.js';

// The pure half of GET /api/tasks. The endpoint used to return every task,
// full text, uncapped — on a mature board that is ~500 tasks / >1 MB / ~320k
// tokens, which every agent hit because the docs showed the call that way.
// These cases pin the progressive-disclosure behaviour that replaced it: the
// default is the ACTIVE lanes, compact, newest-first and capped; every knob
// that widens it is named in the response's own `hint`; every response prices
// itself; and anything still oversized comes back as a 413 carrying the cheap
// summary rather than the payload. All of it runs on plain data — no Express,
// no task store.

const PROJECT = 'C:\\development\\lattice';
const META: ListEnvelopeMeta = {
  project: PROJECT,
  canonicalProject: PROJECT,
  hash: 'abc123def456',
  mismatched: 0,
};

function task(id: string, over: Partial<Task> = {}): Task {
  return {
    id,
    projectPath: PROJECT,
    title: `task ${id}`,
    status: 'open',
    createdAt: 1_000,
    ...over,
  };
}

function parse(raw: Record<string, string | undefined>, now = 1_700_000_000_000): ListQuery {
  const parsed = parseListQuery(raw, now);
  assert.ok(parsed.ok, `expected parse to succeed: ${parsed.ok ? '' : parsed.error}`);
  return parsed.value;
}

function listJson(tasks: Task[], raw: Record<string, string | undefined> = {}): ListEnvelope {
  const outcome = buildListOutcome(META, tasks, parse(raw));
  assert.equal(outcome.kind, 'json', `expected a json outcome, got ${outcome.kind}`);
  return (outcome as { kind: 'json'; body: ListEnvelope }).body;
}

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

// ------------------------------------------------------------- projection --

test('compact projection carries the scan fields and byte counts', () => {
  const t = task('a', {
    status: 'qa',
    createdAt: 10,
    updatedAt: 20,
    description: 'héllo',
    summary: 'done deal',
  });
  const compact = compactTask(t);
  assert.deepEqual(compact, {
    id: 'a',
    title: 'task a',
    status: 'qa',
    createdAt: 10,
    lastActivityAt: 20,
    // é is two bytes in UTF-8 — the counter measures bytes, not characters.
    descriptionBytes: 6,
    summaryBytes: 9,
    updatedAt: 20,
  });
});

test('compact projection passes small flags through ONLY when present', () => {
  const bare = compactTask(task('a'));
  assert.equal('conflict' in bare, false);
  assert.equal('runQueued' in bare, false);
  assert.equal('workflowRunId' in bare, false);
  assert.equal('harness' in bare, false);
  assert.equal('updatedAt' in bare, false);

  const flagged = compactTask(
    task('b', { conflict: true, runQueued: true, workflowRunId: 'wr_1', harness: 'pi' }),
  );
  assert.equal(flagged.conflict, true);
  assert.equal(flagged.runQueued, true);
  assert.equal(flagged.workflowRunId, 'wr_1');
  assert.equal(flagged.harness, 'pi');
});

test('compact projection drops the bulky text entirely', () => {
  const body = listJson([task('a', { description: 'x'.repeat(5_000) })]);
  const only = body.tasks[0] as Record<string, unknown>;
  assert.equal(only.description, undefined);
  assert.equal(only.summary, undefined);
  assert.equal(only.descriptionBytes, 5_000);
  assert.equal(body.clipped, 0, 'compact never clips — there is no text to clip');
});

// --------------------------------------------------------------- clipping --

test('full fields clip description and summary at 500 chars by default', () => {
  const body = listJson(
    [task('a', { description: 'd'.repeat(900), summary: 's'.repeat(900) })],
    { fields: 'full' },
  );
  const only = body.tasks[0] as Record<string, unknown>;
  assert.equal((only.description as string).length, DEFAULT_CLIP_CHARS + 1);
  assert.ok((only.description as string).endsWith('…'));
  assert.equal(only.descriptionTruncated, true);
  assert.equal(only.summaryTruncated, true);
  // The FULL length rides along so the caller can price the un-clipped fetch.
  assert.equal(only.descriptionBytes, 900);
  assert.equal(only.summaryBytes, 900);
  assert.equal(body.clipped, 1);
});

test('clip= sets a custom budget and leaves shorter text untouched', () => {
  const body = listJson(
    [task('a', { description: 'd'.repeat(40) }), task('b', { description: 'short' })],
    { fields: 'full', clip: '10' },
  );
  const [first, second] = body.tasks as Array<Record<string, unknown>>;
  assert.equal(first.description, `${'d'.repeat(10)}…`);
  assert.equal(first.descriptionTruncated, true);
  assert.equal(second.description, 'short');
  assert.equal('descriptionTruncated' in second, false);
  assert.equal('descriptionBytes' in second, false, 'unclipped full tasks stay untouched');
  assert.equal(body.clipped, 1);
});

test('clip=0 is unlimited', () => {
  const body = listJson([task('a', { description: 'd'.repeat(5_000) })], {
    fields: 'full',
    clip: '0',
  });
  assert.equal((body.tasks[0] as Task).description!.length, 5_000);
  assert.equal(body.clipped, 0);
});

test('a non-numeric clip is a parse error', () => {
  const parsed = parseListQuery({ clip: 'lots' });
  assert.equal(parsed.ok, false);
  assert.match(parsed.ok ? '' : parsed.error, /clip must be a non-negative integer/);
});

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

// ------------------------------------------------------------------- hint --

test('hint teaches only the knobs this response actually needed', () => {
  const many = Array.from({ length: 150 }, (_, i) => task(`t${i}`, { createdAt: i }));
  many.push(task('d1', { status: 'done' }), task('d2', { status: 'done' }));

  const defaulted = listJson(many).hint ?? '';
  assert.match(defaulted, /2 done and 0 deleted tasks omitted by default/);
  assert.match(defaulted, /pass status=done or status=all to include them/);
  assert.match(defaulted, /Showing 100 of 150 matching tasks \(newest first\)/);
  assert.match(defaulted, /raise limit= \(max 1000, 0 = unlimited\)/);
  assert.match(defaulted, /Compact fields — pass fields=full for descriptions/);

  const clipped = listJson([task('a', { description: 'd'.repeat(900) })], {
    status: 'all',
    fields: 'full',
    clip: '100',
  }).hint;
  assert.match(clipped ?? '', /1 tasks have description\/summary clipped at 100 chars/);
  assert.match(clipped ?? '', /GET \/api\/tasks\/:id \(or \?ids=\) for full text, or pass clip=0\./);
});

test('a response that is narrow in every dimension carries no hint at all', () => {
  const body = listJson([task('a')], {
    status: 'all',
    fields: 'full',
    clip: '0',
    limit: '0',
  });
  assert.equal(body.hint, undefined);
});

test('an empty compact result does not nag about fields=full', () => {
  const body = listJson([task('a', { status: 'done' })], { status: 'qa' });
  assert.equal(body.count, 0);
  assert.equal(body.hint, undefined);
});

// -------------------------------------------------------------- self-price --

test('every response reports its own size, with approxTokens = ceil(bytes/4)', () => {
  const body = listJson([task('a'), task('b')]);
  assert.equal(typeof body.bytes, 'number');
  assert.ok(body.bytes > 0);
  assert.equal(body.approxTokens, Math.ceil(body.bytes / 4));
  // Measured on the envelope minus the two self-referential fields, so it is
  // within a few digits of the real body rather than exact.
  assert.ok(Math.abs(jsonBytes(body) - body.bytes) < 64);
});

// ---------------------------------------------------------------- ceiling --

function hugeBoard(): Task[] {
  return Array.from({ length: 40 }, (_, i) =>
    task(`t${i}`, { createdAt: i, description: 'x'.repeat(10_000) }),
  );
}

test('an oversized list becomes a 413 payload carrying the summary + suggestions', () => {
  const outcome = buildListOutcome(
    META,
    hugeBoard(),
    parse({ status: 'all', fields: 'full', clip: '0', limit: '0' }),
  );
  assert.equal(outcome.kind, 'too-large');
  const body = (outcome as { body: TooLargeBody }).body;
  assert.equal(body.error, 'response-too-large');
  assert.ok(body.bytes > LIST_RESPONSE_CEILING_BYTES);
  assert.equal(body.ceilingBytes, LIST_RESPONSE_CEILING_BYTES);
  assert.equal(body.approxTokens, Math.ceil(body.bytes / 4));
  assert.match(body.hint, /This response would be ~\d+ tokens\. Narrow it, or confirm_large=1\./);
  // The 413 is the teaching moment, so it hands over the call the caller should
  // have made rather than making them go find it.
  assert.equal(body.summary.total, 40);
  assert.equal(body.summary.canonicalProject, META.canonicalProject);
  assert.equal(body.suggestions.length, 6);
  assert.ok(body.suggestions.some((s) => s.startsWith('GET /api/tasks/summary?project=')));
  assert.ok(body.suggestions.some((s) => s.includes('confirm_large=1')));
});

test('confirm_large=1 bypasses the ceiling', () => {
  const outcome = buildListOutcome(
    META,
    hugeBoard(),
    parse({ status: 'all', fields: 'full', clip: '0', limit: '0', confirm_large: '1' }),
  );
  assert.equal(outcome.kind, 'json');
  assert.equal((outcome as { body: ListEnvelope }).body.count, 40);
});

test('the defaults keep that same board comfortably under the ceiling', () => {
  // The whole point: the call an agent makes without thinking must be cheap.
  const body = listJson(hugeBoard());
  assert.ok(body.bytes < LIST_RESPONSE_CEILING_BYTES / 10, `bytes=${body.bytes}`);
});

// --------------------------------------------------------------- markdown --

test('format=markdown never clips and records the filter actually applied', () => {
  const outcome = buildListOutcome(
    META,
    [task('a', { description: 'd'.repeat(900) }), task('c', { status: 'done' })],
    parse({ format: 'markdown' }),
  );
  assert.equal(outcome.kind, 'markdown');
  const md = (outcome as { markdown: string }).markdown;
  // Clipping a doc that round-trips through /upsert (which REPLACES
  // descriptions) would silently destroy task text on the way back.
  assert.ok(md.includes('d'.repeat(900)));
  assert.ok(!md.includes('…'));
  assert.match(md, /status=backlog,open,in_progress,ready_to_merge,qa/);
  assert.ok(!md.includes('# {id=c'), 'the default lane filter still applies');
});

test('a markdown listing capped by limit says so in-band and still parses to exactly the page', () => {
  // The JSON envelope carries `truncated`; the markdown doc used to carry
  // nothing, so a 250-task lane came back as its newest 100 with no sign the
  // rest existed — and an agent triaged / re-upserted believing it had it all.
  const tasks = Array.from({ length: 150 }, (_, i) =>
    task(`t${i}`, { status: 'backlog', createdAt: 1_000 + i, description: `d${i}\n\n# Plan\nstep` }),
  );
  const outcome = buildListOutcome(META, tasks, parse({ status: 'backlog', format: 'markdown' }));
  assert.equal(outcome.kind, 'markdown');
  const md = (outcome as { markdown: string }).markdown;
  assert.match(md, new RegExp(`truncated=${DEFAULT_LIST_LIMIT}/150`));
  assert.match(md, new RegExp(`showing ${DEFAULT_LIST_LIMIT} of 150`));
  const doc = parseMarkdownDoc(md);
  assert.equal(doc.tasks.length, DEFAULT_LIST_LIMIT, 'no extra tasks from the marker or the # Plan lines');
  for (const t of doc.tasks) {
    assert.ok(t.id);
    assert.match(t.description ?? '', /^d\d+\n\n# Plan\nstep$/);
  }

  const all = buildListOutcome(META, tasks, parse({ status: 'backlog', format: 'markdown', limit: '0' }));
  const allMd = (all as { markdown: string }).markdown;
  assert.ok(!allMd.includes('truncated='), 'an uncapped listing carries no marker');
  assert.equal(parseMarkdownDoc(allMd).tasks.length, 150);
});

// ---------------------------------------------------------------- summary --

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

// -------------------------------------------------------------- parse edge --

test('fields only accepts compact or full', () => {
  assert.equal(parse({ fields: 'FULL' }).fields, 'full');
  const parsed = parseListQuery({ fields: 'brief' });
  assert.equal(parsed.ok, false);
  assert.match(parsed.ok ? '' : parsed.error, /fields must be "compact" or "full"/);
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

test('a markdown response over the ceiling is a 413 too', () => {
  // `format=markdown` never clips, so a big lane is exactly where the ceiling
  // earns its keep — a 413 body must not be what lands in the agent's .md file
  // (the recipe uses curl --fail for that reason).
  const tasks = Array.from({ length: 300 }, (_, i) =>
    task(`t${i}`, { status: 'open', description: 'x'.repeat(1000) }),
  );
  const outcome = buildListOutcome(META, tasks, parse({ format: 'markdown', limit: '0' }));
  assert.equal(outcome.kind, 'too-large');
  const ok = buildListOutcome(META, tasks, parse({ format: 'markdown', limit: '0', confirm_large: '1' }));
  assert.equal(ok.kind, 'markdown');
});

test('the list envelope is serialized once: the wire form equals JSON.stringify of the envelope', () => {
  const tasks = Array.from({ length: 7 }, (_, i) => task(`t${i}`, { description: `d${i} é ${'x'.repeat(50)}` }));
  for (const raw of [{}, { fields: 'full' }, { fields: 'full', clip: '20' }, { ids: 't1,t9' }]) {
    const { envelope, json } = buildListEnvelopeJson(META, selectTasks(tasks, parse(raw)), parse(raw));
    assert.equal(json, JSON.stringify(envelope), `wire form for ${JSON.stringify(raw)}`);
    const { bytes: _b, approxTokens: _t, ...measurable } = envelope;
    assert.equal(envelope.bytes, jsonBytes(measurable), 'bytes still measure the envelope without its own price');
    assert.equal(envelope.approxTokens, approxTokens(envelope.bytes));
  }
});
