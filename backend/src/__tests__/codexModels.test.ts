// Codex model list for the workflow model selects (read from the Codex CLI's
// own catalog cache) and the evidence-backed effort suggestions beside it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { listCodexModels, parseCodexModelsCache } from '../codexModels.js';
import { effortSuggestion } from '../shared/launchGuidance.js';

test('only models Codex lists in its own picker are offered', () => {
  const models = parseCodexModelsCache({
    models: [
      { slug: 'gpt-6-luna', display_name: 'GPT-6-Luna', visibility: 'list', description: 'Fast.', default_reasoning_level: 'medium', supported_reasoning_levels: [{ effort: 'low' }, { effort: 'max' }] },
      { slug: 'codex-auto-review', visibility: 'hide' },
      { display_name: 'no slug', visibility: 'list' },
    ],
  });
  assert.deepEqual(models, [
    { id: 'gpt-6-luna', displayName: 'GPT-6-Luna', description: 'Fast.', efforts: ['low', 'max'], defaultEffort: 'medium' },
  ]);
});

test('an unrecognized or absent cache is an empty list, never a throw', async () => {
  assert.deepEqual(parseCodexModelsCache(null), []);
  assert.deepEqual(parseCodexModelsCache({ models: 'x' }), []);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-home-'));
  try {
    assert.deepEqual(await listCodexModels(dir), []);
    await fs.writeFile(path.join(dir, 'models_cache.json'), '{not json');
    assert.deepEqual(await listCodexModels(dir), []);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('effort suggestions are per harness, model and role', () => {
  assert.equal(effortSuggestion('codex', 'gpt-6-luna', 'tasks')?.effort, 'medium');
  assert.equal(effortSuggestion('codex', undefined, 'tasks'), undefined);
  assert.equal(effortSuggestion('codex', 'gpt-6-luna', 'step')?.effort, 'high');
  assert.equal(effortSuggestion('claude', 'opus', 'step')?.effort, 'high');
  assert.equal(effortSuggestion('pi', undefined, 'tasks'), undefined);
  assert.equal(effortSuggestion(undefined, undefined, 'step'), undefined);
});
