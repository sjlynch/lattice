// Clearing the final advanced override must survive the save boundary without
// changing the draft editor's contract or clearing untouched adoption fields.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PiProvider } from '../api';
import {
  applyDetectedModels,
  cleanHeaders,
  piProvidersPatch,
  removeHeaderEntry,
  sanitizeProvidersForSave,
  setCompatKey,
} from '../components/settings/piTabUtils.ts';

const endpoint = (over: Partial<PiProvider> = {}): PiProvider => ({
  id: 'box',
  baseUrl: 'http://old/v1',
  models: [{ id: 'org/model', contextWindow: 4096 }],
  ...over,
});

test('save distinguishes untouched advanced fields from explicitly emptied maps', () => {
  const untouched = sanitizeProvidersForSave([endpoint()])[0];
  assert.equal(untouched.headers, undefined);
  assert.equal(untouched.compat, undefined);
  // The cleanup helper itself retains its historical empty-map contract.
  assert.equal(cleanHeaders({}), undefined);
  assert.equal(cleanHeaders({ '   ': 'never sent' }), undefined);

  const emptied = sanitizeProvidersForSave([
    endpoint({ headers: {}, compat: {} }),
  ])[0];
  assert.deepEqual(emptied.headers, {});
  assert.deepEqual(emptied.compat, {});
  // Cleaning the only half-typed row still clears any previous effective map.
  assert.deepEqual(
    sanitizeProvidersForSave([endpoint({ headers: { '   ': 'secret' } })])[0].headers,
    {},
  );
});

test('final compat/header removal survives subsequent endpoint edits and probes', () => {
  const saved = endpoint({
    headers: { Authorization: 'Bearer old-secret' },
    compat: { supportsReasoningEffort: false },
  });
  const cleared = setCompatKey(saved, 'supportsReasoningEffort', undefined);
  assert.equal('compat' in cleared, false, 'the draft still drops the final object');
  const draft = {
    ...cleared,
    headers: removeHeaderEntry(saved.headers, 0),
    baseUrl: 'http://new/v1',
  };
  const probed = applyDetectedModels([draft], 'box', [
    { id: 'org/model', contextWindow: 8192 },
  ]);
  assert.equal(piProvidersPatch(probed, { loaded: false, touched: true }), undefined);
  assert.equal(piProvidersPatch(probed, { loaded: true, touched: false }), undefined);
  const patch = piProvidersPatch(probed, { loaded: true, touched: true });
  assert.ok(patch);
  assert.deepEqual(patch[0].headers, {});
  assert.deepEqual(patch[0].compat, {});
  assert.deepEqual(Object.getOwnPropertySymbols(patch[0]), [], 'no draft marker leaks');
  const wire = JSON.parse(JSON.stringify(patch));
  assert.deepEqual(wire[0], {
    id: 'box',
    baseUrl: 'http://new/v1',
    models: [{ id: 'org/model', contextWindow: 8192 }],
    headers: {},
    compat: {},
  });
  assert.deepEqual(saved.headers, { Authorization: 'Bearer old-secret' });
  assert.deepEqual(saved.compat, { supportsReasoningEffort: false });
});

test('compat edits preserve surviving keys and replace a pending clear when set again', () => {
  const saved = endpoint({
    compat: { thinkingFormat: 'custom-format', supportsReasoningEffort: false },
  });
  const partial = setCompatKey(saved, 'supportsReasoningEffort', undefined);
  assert.deepEqual(sanitizeProvidersForSave([partial])[0].compat, {
    thinkingFormat: 'custom-format',
  });
  const cleared = setCompatKey(partial, 'thinkingFormat', '');
  assert.equal('compat' in cleared, false);
  assert.deepEqual(sanitizeProvidersForSave([cleared])[0].compat, {});
  const reset = setCompatKey(cleared, 'supportsDeveloperRole', false);
  assert.deepEqual(sanitizeProvidersForSave([reset])[0].compat, {
    supportsDeveloperRole: false,
  });
});
