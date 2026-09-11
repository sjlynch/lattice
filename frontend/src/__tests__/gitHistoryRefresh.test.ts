import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { GitHistoryResult } from '../api';
import { createGitHistoryRefresh } from '../components/forceGraph/hooks/gitHistoryRefresh.ts';

function history(signature: string): GitHistoryResult {
  return { signature, isRepo: true, commits: [], uncommitted: { changes: [] }, deletedPaths: [] };
}

function harness() {
  const requests: Array<{
    signal: AbortSignal;
    resolve: (history: GitHistoryResult) => void;
    reject: (error: Error) => void;
  }> = [];
  const published: GitHistoryResult[] = [];
  let errors = 0;
  const refresh = createGitHistoryRefresh({
    load: (signal) => new Promise((resolve, reject) => requests.push({ signal, resolve, reject })),
    onHistory: (value) => published.push(value),
    onError: () => errors++,
  });
  return { requests, published, refresh, errors: () => errors };
}

async function flush() {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

test('initial HTTP load and matching websocket snapshot share exactly one request', async () => {
  const h = harness();
  h.refresh.start();
  for (let i = 0; i < 20; i++) h.refresh.notifySignature('A');
  assert.equal(h.requests.length, 1);
  h.requests[0].resolve(history('A'));
  await flush();
  h.refresh.notifySignature('A');
  assert.equal(h.requests.length, 1);
  assert.deepEqual(h.published.map((value) => value.signature), ['A']);
  h.refresh.dispose();
});

test('a burst during a slow load collapses to the newest follow-up without publishing stale history', async () => {
  const h = harness();
  h.refresh.start();
  for (let i = 1; i <= 50; i++) h.refresh.notifySignature(`S${i}`);
  assert.equal(h.requests.length, 1, 'requests must never overlap');
  h.requests[0].resolve(history('S1'));
  await flush();
  assert.equal(h.requests.length, 2);
  assert.equal(h.published.length, 0, 'obsolete ghosts and rings must not flicker');
  h.requests[1].resolve(history('S50'));
  await flush();
  assert.deepEqual(h.published.map((value) => value.signature), ['S50']);
  assert.equal(h.requests.length, 2);
  h.refresh.dispose();
});

test('a response already containing the newest pending signature avoids even the follow-up', async () => {
  const h = harness();
  h.refresh.notifySignature('A');
  h.refresh.notifySignature('B');
  h.requests[0].resolve(history('B'));
  await flush();
  assert.equal(h.requests.length, 1);
  assert.equal(h.published[0].signature, 'B');
  h.refresh.dispose();
});

test('response newer than its initiating hint is accepted without repeatedly chasing the old hint', async () => {
  const h = harness();
  h.refresh.notifySignature('A');
  h.refresh.notifySignature('A');
  h.requests[0].resolve(history('B'));
  await flush();
  assert.equal(h.requests.length, 1);
  assert.equal(h.published[0].signature, 'B');
  h.refresh.dispose();
});

test('reverting to the last good signature supersedes a different in-flight request', async () => {
  const h = harness();
  h.refresh.notifySignature('A');
  h.requests[0].resolve(history('A'));
  await flush();
  h.refresh.notifySignature('B');
  h.refresh.notifySignature('A');
  h.requests[1].resolve(history('B'));
  await flush();
  assert.equal(h.requests.length, 3);
  assert.deepEqual(h.published.map((value) => value.signature), ['A']);
  h.requests[2].resolve(history('A'));
  await flush();
  assert.deepEqual(h.published.map((value) => value.signature), ['A', 'A']);
  h.refresh.dispose();
});

test('A to B to A during a request still fences an intermediate B result', async () => {
  const h = harness();
  h.refresh.notifySignature('A');
  h.refresh.notifySignature('B');
  h.refresh.notifySignature('A');
  h.requests[0].resolve(history('B'));
  await flush();
  assert.equal(h.requests.length, 2);
  assert.equal(h.published.length, 0);
  h.requests[1].resolve(history('A'));
  await flush();
  assert.equal(h.published[0].signature, 'A');
  h.refresh.dispose();
});

test('failure does not poison signature deduplication and a new pending signature still loads', async () => {
  const h = harness();
  h.refresh.notifySignature('A');
  h.requests[0].resolve(history('A'));
  await flush();
  h.refresh.notifySignature('B');
  h.requests[1].reject(new Error('backend restarting'));
  await flush();
  assert.equal(h.errors(), 1);
  assert.deepEqual(h.published.map((value) => value.signature), ['A']);
  h.refresh.notifySignature('B');
  assert.equal(h.requests.length, 3, 'same failed hint is retryable on reconnect');
  h.refresh.notifySignature('C');
  h.requests[2].reject(new Error('still restarting'));
  await flush();
  assert.equal(h.requests.length, 4);
  assert.equal(h.errors(), 1, 'superseded failure does not blank the timeline');
  h.requests[3].resolve(history('C'));
  await flush();
  assert.deepEqual(h.published.map((value) => value.signature), ['A', 'C']);
  h.refresh.dispose();
});

test('dispose aborts HTTP and fences completion, pending follow-up, and late socket events', async () => {
  const h = harness();
  h.refresh.start();
  h.refresh.notifySignature('A');
  h.refresh.dispose();
  assert.equal(h.requests[0].signal.aborted, true);
  // A fetch double deliberately ignores abort to test the publication fence.
  h.requests[0].resolve(history('B'));
  await flush();
  h.refresh.notifySignature('C');
  h.refresh.start();
  assert.equal(h.requests.length, 1);
  assert.equal(h.published.length, 0);
  assert.equal(h.errors(), 0);
});
