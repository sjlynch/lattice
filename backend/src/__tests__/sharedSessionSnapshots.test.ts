import { test } from 'node:test';
import assert from 'node:assert/strict';
import { proxyListSessionsShared, resetSessionsSnapshot } from '../terminalServerClient/sessions.js';
import { listRolloutFilesShared, resetCodexDiscoveryCaches } from '../terminalRegistry/codexDiscovery.js';

// Two periodic readers of the same list are collapsed onto one fetch per short
// TTL: the terminal-server `/sessions` list (the activity poller; the registry
// watch deliberately reads live — see terminalRegistry/watch.ts) and the Codex
// rollout directory listing (every in-flight Codex discovery).

test('proxyListSessionsShared single-flights concurrent readers and serves a TTL snapshot', async () => {
  resetSessionsSnapshot();
  let now = 10_000;
  let calls = 0;
  let resolve!: (v: unknown[] | null) => void;
  const list = () => { calls += 1; return new Promise<unknown[] | null>((r) => { resolve = r; }); };
  const opts = { ttlMs: 750, now: () => now, list };
  const a = proxyListSessionsShared(opts);
  const b = proxyListSessionsShared(opts);
  assert.equal(calls, 1, 'in flight → shared');
  resolve([{ id: 'x' }]);
  assert.deepEqual(await a, [{ id: 'x' }]);
  assert.deepEqual(await b, [{ id: 'x' }]);
  now += 500;
  assert.deepEqual(await proxyListSessionsShared(opts), [{ id: 'x' }]);
  assert.equal(calls, 1, 'within the TTL → snapshot');
  now += 500;
  const c = proxyListSessionsShared(opts);
  assert.equal(calls, 2, 'past the TTL → refetch');
  resolve(null);
  assert.equal(await c, null, '"can\'t tell" is passed through, never coerced to []');
  resetSessionsSnapshot();
});

test('listRolloutFilesShared shares one listing per (root, days) within the TTL', async () => {
  resetCodexDiscoveryCaches();
  let now = 5_000;
  const calls: Array<[string, number]> = [];
  const list = async (root: string, days: number) => { calls.push([root, days]); return [{ file: `${root}/r.jsonl`, mtimeMs: 1 }]; };
  const opts = { ttlMs: 1_500, now: () => now, list };
  const [a, b] = await Promise.all([
    listRolloutFilesShared('R', 3, opts),
    listRolloutFilesShared('R', 3, opts),
  ]);
  assert.equal(a, b);
  assert.equal(calls.length, 1);
  await listRolloutFilesShared('R', 5, opts);
  assert.equal(calls.length, 2, 'a different window is a different listing');
  now += 1_600;
  await listRolloutFilesShared('R', 3, opts);
  assert.equal(calls.length, 3, 'past the TTL → re-list');
  resetCodexDiscoveryCaches();
});
