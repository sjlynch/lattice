// Regression: a throwing initial delivery rejected subscribe before its caller
// received cleanup, retaining dead socket callbacks in process-long slots.
// Rollback must preserve a registration from an earlier call using the same cb.

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import {
  createProjectWatcherRegistry,
  publishIfChanged,
  type ProjectWatcherSlot,
} from '../gitWatcherRegistry.js';

function createHarness() {
  const root = process.cwd();
  const label = '[test watcher]';
  const slot: ProjectWatcherSlot<string> = {
    root,
    subscribers: new Set(),
    current: 'initial',
  };
  const create = mock.fn(async (canonicalRoot: string) => {
    slot.root = canonicalRoot;
    return slot;
  });
  const close = mock.fn(async () => {});
  const registry = createProjectWatcherRegistry<ProjectWatcherSlot<string>, string>({
    label,
    create,
    arm: async () => {},
    compute: async () => slot.current,
    close,
  });
  return { root, label, slot, registry, create, close };
}

test('failed initial delivery removes a fresh registration and preserves other subscribers', async (t) => {
  const { root, label, slot, registry, create, close } = createHarness();
  t.after(() => registry.resetForTest());
  const earlier: string[] = [];
  const unsubscribeEarlier = await registry.subscribe(root, (value) => earlier.push(value));
  const failure = new Error('initial send failed');
  const failing = mock.fn(() => { throw failure; });

  await assert.rejects(registry.subscribe(root, failing), (err) => err === failure);
  assert.equal(slot.subscribers.has(failing), false);
  assert.equal(slot.subscribers.size, 1);

  const later: string[] = [];
  const unsubscribeLater = await registry.subscribe(root, (value) => later.push(value));
  publishIfChanged(label, slot, 'updated');
  assert.deepEqual(earlier, ['initial', 'updated']);
  assert.deepEqual(later, ['initial', 'updated']);
  assert.equal(failing.mock.callCount(), 1, 'failed callback is never delivered an update');
  assert.equal(create.mock.callCount(), 1, 'later subscriptions reuse the watcher');
  unsubscribeEarlier();
  unsubscribeLater();
  assert.equal(close.mock.callCount(), 0, 'the watcher remains alive without subscribers');
});

test('failed initial delivery with an already registered callback keeps its earlier registration', async (t) => {
  const { root, label, slot, registry } = createHarness();
  t.after(() => registry.resetForTest());
  const failure = new Error('duplicate send failed');
  const seen: string[] = [];
  let failDelivery = false;
  const callback = (value: string) => {
    if (failDelivery) throw failure;
    seen.push(value);
  };
  const unsubscribe = await registry.subscribe(root, callback);

  failDelivery = true;
  await assert.rejects(registry.subscribe(root, callback), (err) => err === failure);
  assert.equal(slot.subscribers.has(callback), true);
  assert.equal(slot.subscribers.size, 1);

  failDelivery = false;
  publishIfChanged(label, slot, 'updated');
  assert.deepEqual(seen, ['initial', 'updated']);
  unsubscribe();
  publishIfChanged(label, slot, 'after unsubscribe');
  assert.deepEqual(seen, ['initial', 'updated']);
  assert.equal(slot.subscribers.size, 0);
});

test('successful subscriptions deliver before resolving and keep Set-based unsubscribe semantics', async (t) => {
  const { root, label, slot, registry, create, close } = createHarness();
  t.after(() => registry.resetForTest());
  const seen: string[] = [];
  const callback = (value: string) => seen.push(value);
  const unsubscribe = await registry.subscribe(root, callback).then((cleanup) => {
    assert.deepEqual(seen, ['initial'], 'current value arrives before subscribe resolves');
    return cleanup;
  });
  const unsubscribeDuplicate = await registry.subscribe(root, callback);
  assert.deepEqual(seen, ['initial', 'initial']);
  assert.equal(slot.subscribers.size, 1);
  assert.equal(create.mock.callCount(), 1);

  publishIfChanged(label, slot, 'updated');
  publishIfChanged(label, slot, 'updated');
  assert.deepEqual(seen, ['initial', 'initial', 'updated']);
  unsubscribeDuplicate();
  unsubscribe();
  unsubscribe();
  publishIfChanged(label, slot, 'after unsubscribe');
  assert.deepEqual(seen, ['initial', 'initial', 'updated']);
  assert.equal(slot.subscribers.size, 0);
  assert.equal(close.mock.callCount(), 0);
});
