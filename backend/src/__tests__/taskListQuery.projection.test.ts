// GET /api/tasks field projection (fixtures: helpers/taskListQuery.ts). The
// default compact projection carries the scan fields and byte counts but none
// of the bulky text; fields=full clips description/summary at 500 chars by
// default (clip= sets the budget, clip=0 is unlimited) and keeps the FULL byte
// length so the caller can price the un-clipped fetch. A bad fields or clip
// value is a parse error.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CLIP_CHARS, compactTask, parseListQuery } from '../routes/tasks/listQuery.js';
import type { Task } from '../tasks.js';
import { listJson, parse, task } from './helpers/taskListQuery.js';

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

test('fields only accepts compact or full', () => {
  assert.equal(parse({ fields: 'FULL' }).fields, 'full');
  const parsed = parseListQuery({ fields: 'brief' });
  assert.equal(parsed.ok, false);
  assert.match(parsed.ok ? '' : parsed.error, /fields must be "compact" or "full"/);
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
