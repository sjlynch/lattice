import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reconcileHiddenExtsPersist } from '../hooks/hiddenExtsPersist.ts';

const PREFIX = 'lattice.hiddenExts.';
const keyFor = (folder: string) => `${PREFIX}${folder}`;

// Replay the effect sequence the hook produces for a series of React commits.
// Each commit is the (key, hiddenExts) pair visible to the persist effect on a
// given render; the load effect is modelled by which value each commit carries.
// Returns the writes the persist effect actually performed against storage.
function replayPersist(
  commits: Array<{ key: string | null; exts: string[] }>,
): Record<string, string> {
  const store: Record<string, string> = {};
  let reconciledKey: string | null = null;
  for (const { key, exts } of commits) {
    const { write, nextKey } = reconcileHiddenExtsPersist(key, reconciledKey);
    reconciledKey = nextKey;
    if (write && key) store[key] = JSON.stringify(exts);
  }
  return store;
}

test('folder switch never writes project A’s hidden set onto B’s key', () => {
  const A = 'C:/proj-a';
  const B = 'C:/proj-b';
  // 1. mount on A (initial empty), 2. A loaded {.json}, 3. user toggles .md,
  // 4. switch to B — key is B but state is still A's set (load not committed),
  // 5. B's loaded set commits.
  const store = replayPersist([
    { key: keyFor(A), exts: [] },
    { key: keyFor(A), exts: ['.json'] },
    { key: keyFor(A), exts: ['.json', '.md'] },
    { key: keyFor(B), exts: ['.json', '.md'] }, // danger render: A's set under B's key
    { key: keyFor(B), exts: [] }, // B's real loaded set
  ]);

  // B's key must never have received A's array, transiently or otherwise.
  assert.notEqual(store[keyFor(B)], JSON.stringify(['.json', '.md']));
  // B ends up with its own (empty) set; A keeps the genuine toggle.
  assert.equal(store[keyFor(B)], JSON.stringify([]));
  assert.equal(store[keyFor(A)], JSON.stringify(['.json', '.md']));
});

test('genuine toggles under a stable key are persisted', () => {
  const A = keyFor('C:/proj-a');
  const store = replayPersist([
    { key: A, exts: [] }, // mount: skipped (key just appeared)
    { key: A, exts: ['.ts'] }, // toggle .ts -> written
    { key: A, exts: ['.ts', '.css'] }, // toggle .css -> written
  ]);
  assert.equal(store[A], JSON.stringify(['.ts', '.css']));
});

test('mount does not write the previous (empty) value over the current key', () => {
  // The very first render for a key is always skipped, so a project whose
  // stored set is being loaded is never clobbered by the initial empty state.
  const r = reconcileHiddenExtsPersist(keyFor('C:/proj'), null);
  assert.equal(r.write, false);
  assert.equal(r.nextKey, keyFor('C:/proj'));
});

test('null key (no active folder) never writes and preserves the tracked key', () => {
  const prev = keyFor('C:/proj-a');
  const r = reconcileHiddenExtsPersist(null, prev);
  assert.equal(r.write, false);
  assert.equal(r.nextKey, prev); // a later switch back to a real key still reads as a change
});
