import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildThinkingLevelMap,
  extendsBeyondStandard,
  parseAcceptedEffortTokens,
  sanitizeThinkingLevels,
} from '../piModels/thinkingLevels.js';
import {
  applyThinkingLevels,
  modelsNeedingThinkingProbe,
} from '../piModels/autoDiscover.js';

// The exact message NInfer returns for an invalid effort value. Recovering the
// level list from it is what makes xhigh reachable with zero configuration.
const NINFER_ERROR =
  '{"error":{"code":null,"message":"reasoning_effort must be one of none, ' +
  'minimal, low, medium, high, xhigh, or max","param":"reasoning_effort",' +
  '"type":"invalid_request_error"}}';

test('parseAcceptedEffortTokens recovers the level list from a rejection', () => {
  assert.deepEqual(parseAcceptedEffortTokens(NINFER_ERROR), [
    'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max',
  ]);
});

test('parseAcceptedEffortTokens does not mistake xhigh for high', () => {
  // `high` must not be counted just because it is a substring of `xhigh`.
  assert.deepEqual(parseAcceptedEffortTokens('must be one of low or xhigh'), [
    'low', 'xhigh',
  ]);
});

test('parseAcceptedEffortTokens refuses to guess from prose', () => {
  // A single level word is far likelier to be prose than an enumeration, and a
  // misparse would write a thinkingLevelMap that hides levels that do work.
  assert.deepEqual(parseAcceptedEffortTokens('reasoning_effort: high is not supported'), []);
  assert.deepEqual(parseAcceptedEffortTokens('internal server error'), []);
  assert.deepEqual(parseAcceptedEffortTokens(''), []);
});

test('extendsBeyondStandard only fires for levels Pi cannot already reach', () => {
  // Everything through `high` is Pi's default, so a map for it changes nothing.
  assert.equal(extendsBeyondStandard(['none', 'low', 'medium', 'high']), false);
  assert.equal(extendsBeyondStandard(['low', 'xhigh']), true);
  assert.equal(extendsBeyondStandard(['max']), true);
});

test('buildThinkingLevelMap maps off to the server spelling and nulls the rest', () => {
  assert.deepEqual(
    buildThinkingLevelMap(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']),
    {
      // The server calls it `none`; Pi calls the level `off`.
      off: 'none', minimal: 'minimal', low: 'low', medium: 'medium',
      high: 'high', xhigh: 'xhigh', max: 'max',
    },
  );
  // Levels the server never offered are explicitly unsupported, not missing —
  // a missing key falls back to Pi's default mapping, which is not what we mean.
  assert.deepEqual(buildThinkingLevelMap(['off', 'high', 'max']), {
    off: 'off', minimal: null, low: null, medium: null,
    high: 'high', xhigh: null, max: 'max',
  });
});

test('sanitizeThinkingLevels keeps known tokens and drops junk', () => {
  assert.deepEqual(sanitizeThinkingLevels(['max', 'low', 'low']), ['low', 'max']);
  assert.equal(sanitizeThinkingLevels(['nonsense']), undefined);
  assert.equal(sanitizeThinkingLevels('high'), undefined);
  assert.equal(sanitizeThinkingLevels(undefined), undefined);
});

// Probing costs one request PER MODEL, so it must run once per new model and
// never against an aggregator listing hundreds.
test('modelsNeedingThinkingProbe probes only unprobed models', () => {
  const models = [
    { id: 'fresh' },
    { id: 'probed-extended', thinkingLevels: ['high', 'xhigh'] },
    // [] is the "asked and answered, nothing special" marker — not a retry cue.
    { id: 'probed-ordinary', thinkingLevels: [] },
  ];
  assert.deepEqual(
    modelsNeedingThinkingProbe(models, 25).map((m) => m.id),
    ['fresh'],
  );
});

test('modelsNeedingThinkingProbe skips an aggregator entirely', () => {
  const many = Array.from({ length: 26 }, (_, i) => ({ id: `m${i}` }));
  assert.deepEqual(modelsNeedingThinkingProbe(many, 25), []);
  // One under the limit is still probed.
  assert.equal(modelsNeedingThinkingProbe(many.slice(0, 25), 25).length, 25);
});

test('applyThinkingLevels records extended levels, and marks ordinary ones done', () => {
  assert.deepEqual(
    applyThinkingLevels({ id: 'm' }, ['none', 'high', 'xhigh', 'max']),
    { id: 'm', thinkingLevels: ['none', 'high', 'xhigh', 'max'] },
  );
  // Nothing beyond `high` → store [] so the next sweep doesn't re-probe it.
  assert.deepEqual(applyThinkingLevels({ id: 'm' }, ['none', 'low', 'high']), {
    id: 'm', thinkingLevels: [],
  });
  assert.deepEqual(applyThinkingLevels({ id: 'm' }, []), { id: 'm', thinkingLevels: [] });
});
