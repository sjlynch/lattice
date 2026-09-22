import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AGGREGATOR_MODEL_COUNT,
  applyDetectedModels,
  alwaysShownPatterns,
  dropEndpointKey,
  extendedThinkingLevels,
  formatContextWindow,
  isAggregatorEndpoint,
  nextEndpointId,
  piProvidersPatch,
  sanitizeProvidersForSave,
  shownEndpointModels,
} from '../components/settings/piTabUtils.ts';
import { isValidPiModel } from '../harnesses.ts';
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

// A saved endpoint must list its models before you press "Detect", and a fresh
// probe is the authority on the context window the server currently serves.
test('shownEndpointModels merges saved and probed models, newest window wins', () => {
  const endpoint = ep('box', {
    models: [
      { id: 'kept', contextWindow: 8192 },
      { id: 'gone-from-server', contextWindow: 4096 },
    ],
  });
  const shown = shownEndpointModels(endpoint, [
    { id: 'kept', contextWindow: 262144 },
    { id: 'new', contextWindow: 32768 },
  ]);
  assert.deepEqual(shown, [
    // Re-probed: the server's current window replaces the stored one.
    { id: 'kept', contextWindow: 262144 },
    { id: 'new', contextWindow: 32768 },
    // Still listed (so it can be unchecked) with its saved window.
    { id: 'gone-from-server', contextWindow: 4096 },
  ]);
});

test('shownEndpointModels omits a context window nobody reported', () => {
  assert.deepEqual(shownEndpointModels(ep('box', { models: [{ id: 'a' }] }), []), [
    { id: 'a' },
  ]);
});

test('formatContextWindow renders a compact badge', () => {
  assert.equal(formatContextWindow(262144), '262K ctx');
  assert.equal(formatContextWindow(8192), '8K ctx');
  assert.equal(formatContextWindow(1_048_576), '1M ctx');
  assert.equal(formatContextWindow(512), '512 ctx');
});

// Must stay in lockstep with the backend's PI_MODEL_PATTERN_RE: a pattern this
// rejects has its `--model` flag silently dropped, so the terminal quietly runs
// Pi's default model instead of the one that was picked from the menu.
test('isValidPiModel accepts HuggingFace-style ids an endpoint reports', () => {
  assert.equal(isValidPiModel('qwen-local/qwen'), true);
  assert.equal(isValidPiModel('my-vllm/meta-llama/Llama-3.1-8B-Instruct'), true);
  assert.equal(isValidPiModel('my-vllm/Qwen/Qwen3-Coder-30B:thinking'), true);
  assert.equal(isValidPiModel('qwen'), false);
  assert.equal(isValidPiModel('a/b && curl evil'), false);
  assert.equal(isValidPiModel(undefined), false);
});

// The curation checklist must not offer a checkbox that does nothing: the
// backend surfaces an auto-discovering endpoint's models regardless of
// curation, so those rows render fixed.
test('alwaysShownPatterns covers auto-discovering endpoints only', () => {
  const providers = [
    ep('auto'), // autoDiscover absent → ON
    ep('explicit', { autoDiscover: true }),
    ep('manual', { autoDiscover: false }),
  ];
  const patterns = [
    'auto/qwen',
    'explicit/llama',
    'manual/mistral',
    'gone/orphan',
    // A HuggingFace-style id: only the FIRST segment is the provider.
    'auto/meta-llama/Llama-3.1-8B-Instruct',
  ];
  assert.deepEqual(
    [...alwaysShownPatterns(providers, patterns)].sort(),
    ['auto/meta-llama/Llama-3.1-8B-Instruct', 'auto/qwen', 'explicit/llama'],
  );
});

test('extendedThinkingLevels shows only what Pi could not already reach', () => {
  assert.deepEqual(
    extendedThinkingLevels(['none', 'low', 'high', 'xhigh', 'max']),
    ['xhigh', 'max'],
  );
  // Nothing beyond `high` → no badge; that is Pi's default behaviour anyway.
  assert.deepEqual(extendedThinkingLevels(['none', 'low', 'high']), []);
  assert.deepEqual(extendedThinkingLevels([]), []);
  assert.deepEqual(extendedThinkingLevels(undefined), []);
});

test('shownEndpointModels carries detected thinking levels onto the row', () => {
  const endpoint = ep('box', {
    models: [
      { id: 'thinker', contextWindow: 262144, thinkingLevels: ['high', 'xhigh', 'max'] },
      { id: 'plain', thinkingLevels: [] },
    ],
  });
  assert.deepEqual(shownEndpointModels(endpoint, []), [
    { id: 'thinker', contextWindow: 262144, thinkingLevels: ['high', 'xhigh', 'max'] },
    // An empty list is "probed, nothing extended" — no badge data on the row.
    { id: 'plain' },
  ]);
});

// An aggregator's models must not render as fixed in the curation checklist,
// because the backend does not bypass curation for them either.
test('an aggregator endpoint does not force its models into the menu', () => {
  const models = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `m${i}` }));
  const aggregator = ep('openrouter', { models: models(AGGREGATOR_MODEL_COUNT + 1) });
  const local = ep('swarm', { models: [{ id: 'qwen' }] });
  assert.equal(isAggregatorEndpoint(aggregator), true);
  assert.equal(isAggregatorEndpoint(local), false);
  // Exactly at the limit is still a local endpoint — the rule is "more than".
  assert.equal(
    isAggregatorEndpoint(ep('edge', { models: models(AGGREGATOR_MODEL_COUNT) })),
    false,
  );
  assert.deepEqual(
    [...alwaysShownPatterns([aggregator, local], ['openrouter/m0', 'swarm/qwen'])],
    ['swarm/qwen'],
  );
});

// Regression: "Detect models" is async and used to write its result to the row
// INDEX captured at click time. Removing an earlier endpoint mid-probe shifted
// the rows, so the probe replaced a different endpoint's model list.
test('applyDetectedModels targets the probed endpoint by id, not by stale index', () => {
  const b = ep('b', { models: [{ id: 'keep-me' }] });
  const c = ep('c', { models: [{ id: 'old', contextWindow: 1000 }] });
  // Probe started for `c` at index 2; `a` (index 0) was removed meanwhile.
  const next = applyDetectedModels([b, c], 'c', [
    { id: 'old', contextWindow: 2000 },
    { id: 'new' },
  ]);
  assert.deepEqual(next[0], b, 'the endpoint now at the stale index is untouched');
  assert.deepEqual(next[1].models, [
    { id: 'old', contextWindow: 2000 },
    { id: 'new' },
  ]);
});

test('applyDetectedModels is a no-op when the probed endpoint was removed', () => {
  const cur = [ep('a'), ep('b')];
  assert.equal(applyDetectedModels(cur, 'gone', [{ id: 'x' }]), cur);
});

// Regression: the Pi tab's providers patch is the WHOLE list and the backend
// deletes every managed provider missing from it. A failed global-settings GET
// left the draft empty, and one "Add endpoint" + Save then wiped every endpoint
// the user had configured. Nothing is written until the saved list loaded.
test('piProvidersPatch writes nothing until the saved list loaded', () => {
  const draft = [ep('endpoint-1')];
  assert.equal(piProvidersPatch(draft, { loaded: false, touched: true }), undefined);
  assert.equal(piProvidersPatch(draft, { loaded: true, touched: false }), undefined);
  assert.deepEqual(
    piProvidersPatch(draft, { loaded: true, touched: true }),
    sanitizeProvidersForSave(draft),
  );
});
