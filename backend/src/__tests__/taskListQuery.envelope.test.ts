// GET /api/tasks response envelope (fixtures: helpers/taskListQuery.ts). Every
// knob that widens the default is named in the response's own `hint` (only the
// knobs this response needed); every response prices itself (bytes,
// approxTokens) and is serialized once; and anything still oversized comes back
// as a 413 carrying the cheap summary + suggestions rather than the payload,
// unless confirm_large=1 — while the defaults keep that same board far under
// the ceiling.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LIST_RESPONSE_CEILING_BYTES,
  approxTokens,
  buildListEnvelopeJson,
  buildListOutcome,
  jsonBytes,
  selectTasks,
  type ListEnvelope,
  type TooLargeBody,
} from '../routes/tasks/listQuery.js';
import type { Task } from '../tasks.js';
import { META, listJson, parse, task } from './helpers/taskListQuery.js';

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
