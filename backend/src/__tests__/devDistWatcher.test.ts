import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { watch } from 'node:fs';
import { watchDist } from '../../scripts/dev/distWatcher.mjs';

test('a native dist watcher error does not crash the dev supervisor', async () => {
  let closed = false;
  const watcher = Object.assign(new EventEmitter(), { close() { closed = true; } });
  const close = await watchDist(() => {}, { watchNative: (() => watcher) as unknown as typeof watch });
  assert.doesNotThrow(() => watcher.emit('error', new Error('EPERM: watched directory unavailable')));
  close();
  assert.equal(closed, true);
});

test('a fallback dist watcher error does not crash the dev supervisor', async () => {
  let closed = false;
  const watcher = Object.assign(new EventEmitter(), { async close() { closed = true; } });
  const close = await watchDist(() => {}, {
    watchNative: (() => { throw new Error('unsupported'); }) as typeof watch,
    loadChokidar: async () => ({ watch: () => watcher }),
  });
  assert.doesNotThrow(() => watcher.emit('error', new Error('ENOSPC: watcher resource exhausted')));
  close();
  assert.equal(closed, true);
});
