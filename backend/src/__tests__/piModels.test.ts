import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePiListModels, reconcileModelsCache } from '../piModels.js';
import { sanitizePiProviders } from '../globalSettings.js';
import { normalizePiModel, buildPiModelFlag } from '../worktree/commands.js';

// `pi --list-models` prints a fixed-width table (to stderr). Columns are
// separated by 2+ spaces: provider / model / context / max-out / thinking /
// images. parsePiListModels must skip the header, ignore blank lines, and
// expose provider+model+pattern (the value passed to `pi --model`).
const SAMPLE = [
  'provider      model                   context  max-out  thinking  images',
  'minimax       MiniMax-M2.7            204.8K   131.1K   yes       no    ',
  'openai-codex  gpt-5.5                 272K     128K     yes       yes   ',
  'qwen-local    qwen                    204.8K   32.8K    yes       no',
  '',
].join('\n');

test('parsePiListModels parses the table and skips the header', () => {
  const models = parsePiListModels(SAMPLE);
  assert.equal(models.length, 3);
  assert.deepEqual(models[0], {
    provider: 'minimax',
    model: 'MiniMax-M2.7',
    pattern: 'minimax/MiniMax-M2.7',
    contextWindow: '204.8K',
    thinking: true,
  });
  assert.equal(models[1].pattern, 'openai-codex/gpt-5.5');
  assert.equal(models[2].pattern, 'qwen-local/qwen');
  assert.equal(models[2].thinking, true);
});

test('parsePiListModels returns [] for empty / non-table output', () => {
  assert.deepEqual(parsePiListModels(''), []);
  assert.deepEqual(parsePiListModels('error: pi not configured'), []);
});

// A transient `pi --list-models` failure (timeout / spawn error) is signalled
// to reconcileModelsCache as `raw === null`. It must NOT be cached as a
// successful empty listing — otherwise the menu blanks and curated built-in
// models (which live only in `pi --list-models`, not models.json) vanish for
// the full 30s TTL. A successful-but-empty listing ('') is a real result and
// IS cached.
test('reconcileModelsCache does not cache a transient failure', () => {
  // No prior cache + failure → empty list for this call, but nothing memoized
  // (cache stays null) so the very next call re-probes.
  const cold = reconcileModelsCache(null, null, 1000);
  assert.deepEqual(cold.models, []);
  assert.equal(cold.cache, null);
});

test('reconcileModelsCache keeps the last good cache on a transient failure', () => {
  // A built-in OAuth model (openai-codex/...) only ever appears in
  // `pi --list-models`, never models.json — so the cached listing is the only
  // thing keeping a curated built-in alive. A failed re-probe must preserve it.
  const good = reconcileModelsCache(
    'openai-codex  gpt-5.5  272K  128K  yes  yes',
    null,
    1000,
  );
  assert.equal(good.models[0].pattern, 'openai-codex/gpt-5.5');
  assert.ok(good.cache);

  // Now the probe fails: the stale-but-good cache (and its `at`) is returned
  // unchanged, so the built-in survives and the TTL still lets a later success
  // refresh it.
  const failed = reconcileModelsCache(null, good.cache, 99_999);
  assert.equal(failed.models[0].pattern, 'openai-codex/gpt-5.5');
  assert.equal(failed.cache, good.cache);
});

test('reconcileModelsCache caches a successful (even empty) listing', () => {
  const empty = reconcileModelsCache('', null, 2000);
  assert.deepEqual(empty.models, []);
  assert.deepEqual(empty.cache, { at: 2000, models: [] });
});

test('normalizePiModel accepts provider/model patterns and rejects junk', () => {
  assert.equal(normalizePiModel('qwen-local/qwen'), 'qwen-local/qwen');
  assert.equal(normalizePiModel('openai-codex/gpt-5.5'), 'openai-codex/gpt-5.5');
  assert.equal(normalizePiModel('qwen-local/qwen:thinking'), 'qwen-local/qwen:thinking');
  assert.equal(normalizePiModel('  qwen-local/qwen  '), 'qwen-local/qwen');
  // No provider segment, or shell-injection attempts → rejected.
  assert.equal(normalizePiModel('qwen'), undefined);
  assert.equal(normalizePiModel('qwen-local/qwen"; rm -rf /'), undefined);
  assert.equal(normalizePiModel('a/b && curl evil'), undefined);
  assert.equal(normalizePiModel(''), undefined);
  assert.equal(normalizePiModel(undefined), undefined);
  assert.equal(normalizePiModel(42), undefined);
});

test('buildPiModelFlag quotes a valid model and is empty otherwise', () => {
  assert.equal(buildPiModelFlag('qwen-local/qwen'), ' --model "qwen-local/qwen"');
  assert.equal(buildPiModelFlag(undefined), '');
  assert.equal(buildPiModelFlag('not a model'), '');
});

test('sanitizePiProviders keeps well-formed providers and drops junk', () => {
  const out = sanitizePiProviders([
    {
      id: 'qwen-local',
      baseUrl: 'http://192.168.8.113:8000/v1',
      api: 'openai-completions',
      apiKey: 'local',
      compat: { thinkingFormat: 'qwen-chat-template' },
      models: [
        { id: 'qwen', name: 'Qwen', reasoning: true, contextWindow: 204800 },
        { id: '', name: 'dropped — no id' },
      ],
    },
    { id: '', baseUrl: 'x' }, // no id → dropped
    { id: 'no-url' }, // no baseUrl → dropped
    'garbage',
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].id, 'qwen-local');
  assert.equal(out[0].baseUrl, 'http://192.168.8.113:8000/v1');
  assert.equal(out[0].apiKey, 'local');
  assert.deepEqual(out[0].compat, { thinkingFormat: 'qwen-chat-template' });
  // The model with an empty id is dropped; the good one is kept.
  assert.equal(out[0].models.length, 1);
  assert.equal(out[0].models[0].id, 'qwen');
  assert.equal(out[0].models[0].contextWindow, 204800);
});

test('sanitizePiProviders drops duplicate ids, keeping the first (no silent models.json clobber)', () => {
  const out = sanitizePiProviders([
    { id: 'endpoint-1', baseUrl: 'http://a/v1', models: [{ id: 'm-a' }] },
    { id: 'endpoint-1', baseUrl: 'http://b/v1', models: [{ id: 'm-b' }] },
    { id: 'other', baseUrl: 'http://c/v1', models: [] },
  ]);
  assert.deepEqual(
    out.map((p) => p.id),
    ['endpoint-1', 'other'],
  );
  // The FIRST endpoint-1 wins — the later duplicate is dropped, so reconcile
  // (which upserts into an id-keyed models.json) can't silently overwrite it.
  assert.equal(out[0].baseUrl, 'http://a/v1');
  assert.equal(out[0].models[0].id, 'm-a');
});

test('sanitizePiProviders returns [] for non-arrays', () => {
  assert.deepEqual(sanitizePiProviders(undefined), []);
  assert.deepEqual(sanitizePiProviders({}), []);
  assert.deepEqual(sanitizePiProviders('x'), []);
});
