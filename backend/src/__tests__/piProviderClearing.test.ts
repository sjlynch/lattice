// Regression: removing the last header/compat key made Settings omit the field,
// so reconcile copied the old models.json overrides back (even onto a new URL).
// Exercise real frontend save helpers, JSON, validation, persistence and repeated
// reconcile while protecting hand-written providers and adoption overrides.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  getGlobalSettings,
  sanitizePiProviders,
  updateGlobalSettings,
  type PiProvider,
} from '../globalSettings.js';
import { latticeHomeDir } from '../projectPath.js';
import { piAgentDir } from '../piModels/config.js';
import { reconcilePiModelsJson } from '../piModels/reconcile.js';

if (!process.env.LATTICE_TEST_HOME_ISOLATED) {
  throw new Error(
    'piProviderClearing.test.ts writes Pi/global settings: use the isolateHome.mjs preload.',
  );
}

type SettingsHelpers = {
  piProvidersPatch(
    providers: PiProvider[],
    state: { loaded: boolean; touched: boolean },
  ): PiProvider[] | undefined;
  removeHeaderEntry(
    headers: Record<string, string> | undefined,
    rowIdx: number,
  ): Record<string, string>;
  setCompatKey(
    provider: PiProvider,
    key: string,
    value: string | boolean | undefined,
  ): PiProvider;
};

// A runtime URL keeps frontend source outside the backend compiler's rootDir;
// tsx loads the actual compatibility barrel for this cross-package regression.
async function settingsHelpers(): Promise<SettingsHelpers> {
  return import(
    new URL('../../../frontend/src/components/settings/piTabUtils.ts', import.meta.url).href
  );
}

const modelsFile = () => path.join(piAgentDir(), 'models.json');
type ModelProviders = Record<string, Record<string, unknown>>;

async function seedModels(providers: ModelProviders): Promise<void> {
  await fs.mkdir(piAgentDir(), { recursive: true });
  await fs.mkdir(latticeHomeDir(), { recursive: true });
  await fs.writeFile(modelsFile(), JSON.stringify({ providers, retained: 'top-level' }), 'utf8');
  await fs.writeFile(path.join(latticeHomeDir(), 'piManagedProviders.json'), '[]', 'utf8');
}

async function readModelProviders(): Promise<ModelProviders> {
  return JSON.parse(await fs.readFile(modelsFile(), 'utf8')).providers;
}

async function saveProviders(draft: PiProvider[]): Promise<void> {
  const { piProvidersPatch } = await settingsHelpers();
  const patch = piProvidersPatch(draft, { loaded: true, touched: true });
  assert.ok(patch);
  const wire: unknown = JSON.parse(JSON.stringify(patch));
  await updateGlobalSettings({ piProviders: sanitizePiProviders(wire) });
}

test('validation preserves explicit empty overrides and keeps absence distinct', () => {
  const base = { id: 'box', baseUrl: 'http://box/v1', models: [] };
  const absent = sanitizePiProviders([base])[0];
  assert.equal('headers' in absent, false);
  assert.equal('compat' in absent, false);
  const cleared = sanitizePiProviders([{ ...base, headers: {}, compat: {} }])[0];
  assert.deepEqual(cleared.headers, {});
  assert.deepEqual(cleared.compat, {});
  assert.deepEqual(sanitizePiProviders(JSON.parse(JSON.stringify([cleared]))), [cleared]);
});

test('settings clear final overrides across a URL change and repeated reconciliation', async () => {
  const manual = {
    baseUrl: 'http://hand-written/v1',
    apiKey: '!read-my-key',
    headers: { 'X-Hand-Written': 'keep' },
    compat: { thinkingFormat: 'custom-format' },
    models: [{ id: 'manual-model', extra: 'keep-model-metadata' }],
  };
  await seedModels({ manual });
  await saveProviders([{
    id: 'box',
    baseUrl: 'http://old/v1',
    models: [{ id: 'org/model' }],
    headers: { Authorization: 'Bearer old-secret' },
    compat: { supportsReasoningEffort: false },
  }]);
  await reconcilePiModelsJson();
  const before = await readModelProviders();
  assert.deepEqual(before.box.headers, { Authorization: 'Bearer old-secret' });
  assert.deepEqual(before.box.compat, { supportsReasoningEffort: false });

  const loaded = (await getGlobalSettings()).piProviders ?? [];
  assert.equal(loaded.length, 1);
  const { setCompatKey, removeHeaderEntry } = await settingsHelpers();
  const cleared = setCompatKey(loaded[0], 'supportsReasoningEffort', undefined);
  assert.equal('compat' in cleared, false);
  await saveProviders([{
    ...cleared,
    headers: removeHeaderEntry(loaded[0].headers, 0),
    baseUrl: 'http://new/v1',
  }]);
  const persisted = (await getGlobalSettings()).piProviders ?? [];
  assert.deepEqual(persisted[0].headers, {});
  assert.deepEqual(persisted[0].compat, {});

  for (let sweep = 0; sweep < 3; sweep++) {
    await reconcilePiModelsJson();
    const after = await readModelProviders();
    assert.equal(after.box.baseUrl, 'http://new/v1');
    assert.equal('headers' in after.box, false, 'removed credentials must stay removed');
    assert.equal('compat' in after.box, false, 'the reset compatibility key must stay removed');
    assert.deepEqual(after.manual, manual);
  }
  // Reopening and saving another edit must keep the persisted clear intent.
  const raw = await fs.readFile(modelsFile(), 'utf8');
  await saveProviders(persisted.map((p) => ({ ...p, autoDiscover: false })));
  await reconcilePiModelsJson();
  assert.equal(await fs.readFile(modelsFile(), 'utf8'), raw);
  assert.equal(JSON.parse(raw).retained, 'top-level');
});

test('adopting a hand-written provider preserves absent advanced fields until explicitly cleared', async () => {
  const adopted = {
    baseUrl: 'http://adopt/v1',
    headers: { Authorization: 'Bearer adopted-secret' },
    compat: { thinkingFormat: 'hand-tuned-format' },
    models: [{ id: 'adopted-model' }],
  };
  await seedModels({ adopt: adopted });
  await saveProviders([{
    id: 'adopt',
    baseUrl: adopted.baseUrl,
    models: [{ id: 'adopted-model' }],
  }]);
  for (let sweep = 0; sweep < 2; sweep++) {
    await reconcilePiModelsJson();
    const providers = await readModelProviders();
    assert.deepEqual(providers.adopt.headers, adopted.headers);
    assert.deepEqual(providers.adopt.compat, adopted.compat);
  }
  const loaded = (await getGlobalSettings()).piProviders ?? [];
  assert.equal(loaded[0].headers, undefined);
  assert.equal(loaded[0].compat, undefined);
  // Start again from the hand-written file with no managed ids: explicit clear
  // intent must also win on the first adoption, before ownership is recorded.
  await seedModels({ adopt: adopted });
  await saveProviders([{ ...loaded[0], headers: {}, compat: {} }]);
  for (let sweep = 0; sweep < 2; sweep++) {
    await reconcilePiModelsJson();
    const providers = await readModelProviders();
    assert.equal('headers' in providers.adopt, false);
    assert.equal('compat' in providers.adopt, false);
  }
});
