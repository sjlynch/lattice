import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { WebSocket } from 'ws';
import {
  broadcastToSubscribers,
  holdSubscriber,
  releaseSubscriber,
  SUBSCRIBER_HIGH_WATER_BYTES,
} from '../terminal/broadcast.js';

// The pty→browser fan-out runs in the detached executor that hosts EVERY pty.
// A browser that stops reading must be dropped, never buffered without bound.

type Fake = {
  ws: WebSocket;
  sent: string[];
  terminated: () => number;
  set: (patch: { bufferedAmount?: number; readyState?: number }) => void;
};

function fakeWs(bufferedAmount = 0): Fake {
  const sent: string[] = [];
  let terminated = 0;
  const obj = {
    OPEN: 1,
    readyState: 1,
    bufferedAmount,
    send(d: string) { sent.push(d); },
    terminate() { terminated += 1; },
  };
  return {
    ws: obj as unknown as WebSocket,
    sent,
    terminated: () => terminated,
    set: (patch) => Object.assign(obj, patch),
  };
}

test('a subscriber past the high-water mark is terminated, not sent to', () => {
  const stalled = fakeWs(SUBSCRIBER_HIGH_WATER_BYTES + 1);
  const healthy = fakeWs(SUBSCRIBER_HIGH_WATER_BYTES);
  broadcastToSubscribers(new Set([stalled.ws, healthy.ws]), 'frame');
  assert.equal(stalled.terminated(), 1);
  assert.deepEqual(stalled.sent, []);
  assert.equal(healthy.terminated(), 0);
  assert.deepEqual(healthy.sent, ['frame']);
});

test('a non-OPEN subscriber is skipped silently', () => {
  const closed = fakeWs();
  closed.set({ readyState: 3 });
  broadcastToSubscribers(new Set([closed.ws]), 'frame');
  assert.deepEqual(closed.sent, []);
  assert.equal(closed.terminated(), 0);
});

test('a held subscriber queues frames in order until released', () => {
  const f = fakeWs();
  holdSubscriber(f.ws);
  broadcastToSubscribers(new Set([f.ws]), 'one');
  broadcastToSubscribers(new Set([f.ws]), 'two');
  assert.deepEqual(f.sent, [], 'nothing reaches the socket while on hold');
  assert.deepEqual(releaseSubscriber(f.ws), ['one', 'two']);
  assert.deepEqual(releaseSubscriber(f.ws), [], 'release is one-shot');
  broadcastToSubscribers(new Set([f.ws]), 'three');
  assert.deepEqual(f.sent, ['three'], 'after release, frames flow directly again');
});

test('a hold that grows past the high-water mark terminates the subscriber too', () => {
  const f = fakeWs();
  holdSubscriber(f.ws);
  const big = 'x'.repeat(SUBSCRIBER_HIGH_WATER_BYTES / 2 + 1);
  broadcastToSubscribers(new Set([f.ws]), big);
  assert.equal(f.terminated(), 0);
  broadcastToSubscribers(new Set([f.ws]), big);
  assert.equal(f.terminated(), 1);
  assert.deepEqual(releaseSubscriber(f.ws), [], 'the hold is dropped with the socket');
});
