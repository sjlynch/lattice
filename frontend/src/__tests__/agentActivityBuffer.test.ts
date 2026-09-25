import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PENDING_ACTIVITY_AGENTS,
  PENDING_ACTIVITY_PER_AGENT,
  PENDING_ACTIVITY_TTL_MS,
  PendingActivityBuffer,
} from '../components/forceGraph/agentActivityBuffer.ts';

// A terminal agent's first file frame can beat the presence snapshot that
// creates its node (two sockets). Dropping it left a label-less dot for the
// whole turn; the buffer holds it until the node exists.

test('frames for an agent are replayed in order, once', () => {
  const buf = new PendingActivityBuffer<string>();
  buf.add('a', 'start:x.ts', 0);
  buf.add('a', 'end:x.ts', 5);
  assert.deepEqual(buf.agentIds(), ['a']);
  assert.deepEqual(buf.take('a', 10), ['start:x.ts', 'end:x.ts']);
  assert.deepEqual(buf.take('a', 10), [], 'taken frames are gone');
});

test('frames for an agent that never appears age out', () => {
  const buf = new PendingActivityBuffer<string>();
  buf.add('ghost', 'start:x.ts', 0);
  assert.deepEqual(buf.take('ghost', PENDING_ACTIVITY_TTL_MS + 1), []);
  buf.add('old', 'e', 0);
  buf.add('new', 'e', PENDING_ACTIVITY_TTL_MS + 1); // add() prunes expired agents
  assert.deepEqual(buf.agentIds(), ['new']);
});

test('the buffer is bounded per agent and in agents', () => {
  const buf = new PendingActivityBuffer<number>();
  for (let i = 0; i < PENDING_ACTIVITY_PER_AGENT + 5; i++) buf.add('a', i, 0);
  const kept = buf.take('a', 0);
  assert.equal(kept.length, PENDING_ACTIVITY_PER_AGENT);
  assert.equal(kept.at(-1), PENDING_ACTIVITY_PER_AGENT + 4, 'the newest frames are kept');
  for (let i = 0; i <= PENDING_ACTIVITY_AGENTS; i++) buf.add(`id${i}`, i, 0);
  assert.equal(buf.agentIds().length, PENDING_ACTIVITY_AGENTS);
  assert.ok(!buf.agentIds().includes('id0'), 'the oldest agent is evicted');
});
