import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  dropEndpointKey,
  nextEndpointId,
  sanitizeProvidersForSave,
} from '../components/settings/piTabUtils.ts';
import type { PiProvider } from '../api';

const ep = (id: string, over: Partial<PiProvider> = {}): PiProvider => ({
  id,
  baseUrl: 'http://x/v1',
  models: [],
  ...over,
});

// PART 2 — Add must not re-mint an id already present in the loaded list.
test('nextEndpointId derives a unique endpoint-N from the loaded providers', () => {
  // Fresh list → endpoint-1.
  assert.equal(nextEndpointId([]), 'endpoint-1');
  // A previously-saved endpoint-1 must NOT be re-minted (the duplicate-id bug).
  assert.equal(nextEndpointId([ep('endpoint-1')]), 'endpoint-2');
  // Picks max+1 past gaps and ignores non-matching ids.
  assert.equal(
    nextEndpointId([ep('endpoint-1'), ep('endpoint-3'), ep('my-vllm')]),
    'endpoint-4',
  );
  // Consecutive blank adds keep advancing (each add appends to the list).
  const first = nextEndpointId([ep('endpoint-1')]); // endpoint-2
  const second = nextEndpointId([ep('endpoint-1'), ep(first)]); // endpoint-3
  assert.equal(first, 'endpoint-2');
  assert.equal(second, 'endpoint-3');
});

// PART 2 — duplicate ids must not survive a save (they'd clobber models.json).
test('sanitizeProvidersForSave drops duplicate ids, keeping the first', () => {
  const out = sanitizeProvidersForSave([
    ep('endpoint-1', { baseUrl: 'http://a/v1' }),
    ep('endpoint-1', { baseUrl: 'http://b/v1' }),
    ep('keep', { baseUrl: 'http://c/v1' }),
  ]);
  assert.deepEqual(
    out.map((p) => p.id),
    ['endpoint-1', 'keep'],
  );
  // The first endpoint-1 (its baseUrl) is the one kept.
  assert.equal(out[0].baseUrl, 'http://a/v1');
});

// PART 3 — per-endpoint transient state keyed by id survives removing an
// earlier endpoint; the survivor keeps its OWN detected list (index-keying
// would have misattributed the removed endpoint's data to it).
test('id-keyed endpoint state stays attached after an earlier endpoint is removed', () => {
  let providers = [ep('a'), ep('b')];
  let detected: Record<string, string[]> = { a: ['model-a'], b: ['model-b'] };

  // Remove endpoint 'a' (index 0) and drop its id's entry.
  providers = providers.filter((_, i) => i !== 0);
  detected = dropEndpointKey(detected, 'a');

  // 'b' is now at index 0, but reading by its id still yields its own list.
  const survivor = providers[0];
  assert.equal(survivor.id, 'b');
  assert.deepEqual(detected[survivor.id], ['model-b']);
  assert.equal(detected['a'], undefined);
});

test('dropEndpointKey returns the same reference when the id is absent', () => {
  const map = { a: true };
  assert.equal(dropEndpointKey(map, 'missing'), map);
});
