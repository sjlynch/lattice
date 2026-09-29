// Pi endpoint auto-discovery, end to end against a real local HTTP endpoint:
//   - a Settings save that lands WHILE a thinking-level probe is in flight
//     survives the sweep's write (the lost-update the re-read exists to stop);
//   - removing, repointing or disabling that provider discards its late probe,
//     while a valid result preserves freshly saved model metadata and levels;
//   - probeThinkingLevels is tri-state — a real enumeration, `[]` for a 2xx
//     "validates nothing", and `null` for every kind of no-answer — and a
//     `null` never becomes the `thinkingLevels: []` "asked and answered" marker.
//
// Writes ~/.lattice/globalSettings.json and ~/.pi/agent/models.json — never
// against a real home (see helpers/isolateHome.mjs, preloaded by `npm test`).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { getGlobalSettings, updateGlobalSettings } from '../globalSettings.js';
import { reconcilePiModelsJson } from '../piModels/reconcile.js';
import { sanitizePiProviders } from '../piProviderValidation.js';
import { refreshEndpointDiscovery } from '../piModels/autoDiscover.js';
import { probeThinkingLevels } from '../piModels/probe.js';
import type { PiProvider } from '../piProviderValidation.js';

if (!process.env.LATTICE_TEST_HOME_ISOLATED) {
  throw new Error(
    'autoDiscover.test.ts writes under ~/.lattice and ~/.pi — run it via `npm test` (or with ' +
      '`--import ./src/__tests__/helpers/isolateHome.mjs`), never bare `node --test`.',
  );
}

const NINFER_ERROR =
  '{"error":{"code":null,"message":"reasoning_effort must be one of none, ' +
  'minimal, low, medium, high, xhigh, or max","param":"reasoning_effort",' +
  '"type":"invalid_request_error"}}';

type ChatReply = { status: number; body: string };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

const HAND_WRITTEN_PROVIDER = {
  baseUrl: 'http://127.0.0.1:9/v1',
  apiKey: 'hand-written-key',
  headers: { 'X-Hand-Written': 'keep' },
  models: [{ id: 'hand-written', customMetadata: 'keep' }],
};

async function seedHandWrittenProvider(): Promise<string> {
  const modelsFile = path.join(os.homedir(), '.pi', 'agent', 'models.json');
  await fs.mkdir(path.dirname(modelsFile), { recursive: true });
  await fs.writeFile(modelsFile, JSON.stringify({
    providers: { manual: HAND_WRITTEN_PROVIDER },
  }), 'utf8');
  return modelsFile;
}

// A minimal OpenAI-compatible endpoint: `/v1/models` lists one model and
// `/v1/chat/completions` answers whatever `onChat` decides (asynchronously, so
// a test can act while the request is pending).
async function withEndpoint<T>(
  onChat: (req: http.IncomingMessage) => Promise<ChatReply> | ChatReply,
  fn: (baseUrl: string) => Promise<T>,
  onModels?: (req: http.IncomingMessage) => Promise<ChatReply> | ChatReply,
): Promise<T> {
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/v1/models') {
      void Promise.resolve(onModels?.(req) ?? {
        status: 200, body: JSON.stringify({ data: [{ id: 'm1', max_model_len: 4096 }] }),
      }).then((reply) => {
        res.writeHead(reply.status, { 'Content-Type': 'application/json' });
        res.end(reply.body);
      });
      return;
    }
    if (req.method === 'POST' && req.url === '/v1/chat/completions') {
      req.on('data', () => {});
      req.on('end', () => {
        void Promise.resolve(onChat(req)).then((reply) => {
          res.writeHead(reply.status, { 'Content-Type': 'application/json' });
          res.end(reply.body);
        });
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    return await fn(`http://127.0.0.1:${port}/v1`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test('a settings save landing during the thinking-level probe survives the sweep', async () => {
  await withEndpoint(
    async () => {
      // The probe for box-a's model is in flight. Add endpoint B now — exactly
      // what "add A, save; add B, save while A's probe runs" does in the UI.
      const cur = (await getGlobalSettings()).piProviders ?? [];
      const boxB: PiProvider = {
        id: 'box-b',
        baseUrl: 'http://127.0.0.1:9/v1',
        autoDiscover: false,
        models: [{ id: 'hand-written' }],
      };
      await updateGlobalSettings({ piProviders: [...cur, boxB] });
      return { status: 400, body: NINFER_ERROR };
    },
    async (baseUrl) => {
      const boxA: PiProvider = { id: 'box-a', baseUrl, autoDiscover: true, models: [] };
      await updateGlobalSettings({ piProviders: [boxA] });

      const changed = await refreshEndpointDiscovery({ force: true });
      assert.equal(changed, true);

      const after = (await getGlobalSettings()).piProviders ?? [];
      const ids = after.map((p) => p.id);
      assert.deepEqual(ids, ['box-a', 'box-b'], 'the interleaved save (box-b) must survive');
      const a = after.find((p) => p.id === 'box-a')!;
      // …and the sweep's own result still landed on A: the discovered model,
      // its context window, and the detected extended levels.
      assert.deepEqual(a.models, [
        {
          id: 'm1',
          contextWindow: 4096,
          thinkingLevels: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
        },
      ]);
      const b = after.find((p) => p.id === 'box-b')!;
      assert.deepEqual(b.models, [{ id: 'hand-written' }]);
    },
  );
});

const SAVED_MANUAL_MODELS: PiProvider['models'] = [
  { id: 'm1', name: 'Saved model', contextWindow: 8192, maxTokens: 512 },
  { id: 'manual-only', name: 'Manual model', contextWindow: 16384, maxTokens: 1024 },
];

const invalidations: Array<{
  name: string;
  edit: (provider: PiProvider) => PiProvider | undefined;
}> = [
  { name: 'removed', edit: () => undefined },
  {
    name: 'pointed at a different URL',
    edit: (p) => ({ ...p, baseUrl: `${p.baseUrl}/replacement`, models: SAVED_MANUAL_MODELS }),
  },
  {
    name: 'opted out of discovery',
    edit: (p) => ({ ...p, autoDiscover: false, models: SAVED_MANUAL_MODELS }),
  },
  {
    name: 'given different request headers',
    edit: (p) => ({ ...p, headers: { 'X-Tenant': 'replacement' }, models: SAVED_MANUAL_MODELS }),
  },
  {
    name: 'given a different API key',
    edit: (p) => ({ ...p, apiKey: 'replacement-key', models: SAVED_MANUAL_MODELS }),
  },
];

for (const { name, edit } of invalidations) {
  test(`a late discovery result is discarded when the probed provider is ${name}`, async () => {
    const probeStarted = deferred<void>();
    const reply = deferred<ChatReply>();
    await withEndpoint(
      () => {
        probeStarted.resolve();
        return reply.promise;
      },
      async (baseUrl) => {
        const boxA: PiProvider = {
          id: 'box-a', baseUrl, autoDiscover: true,
          models: [{ id: 'm1', contextWindow: 1024 }],
        };
        const modelsFile = await seedHandWrittenProvider();
        await updateGlobalSettings({ piProviders: [boxA] });
        // Register A as managed first, so removal must also delete it from Pi.
        await reconcilePiModelsJson();
        const before = JSON.parse(await fs.readFile(modelsFile, 'utf8'));
        assert.equal(before.providers['box-a'].baseUrl, baseUrl);
        assert.deepEqual(before.providers.manual, HAND_WRITTEN_PROVIDER);

        const savedA = edit(boxA);
        const savedProviders = savedA ? [savedA] : [];
        const refresh = refreshEndpointDiscovery({ force: true });
        let changed = false;
        try {
          // Reaching chat proves the model listing (4096) has already arrived.
          await Promise.race([
            probeStarted.promise,
            refresh.then(() => assert.fail('sweep settled before its capability probe arrived')),
          ]);
          await updateGlobalSettings({ piProviders: savedProviders });
        } finally {
          // Always release and settle this sweep, including on a save failure.
          reply.resolve({ status: 400, body: NINFER_ERROR });
          changed = await refresh;
        }

        assert.equal(changed, false, 'discarding a stale result is not a discovery change');
        assert.deepEqual((await getGlobalSettings()).piProviders, savedProviders,
          'the saved provider list must survive without stale models, windows or levels');
        // Do not reconcile explicitly after the edit: even an unchanged sweep
        // must repair models.json from the current settings, preserving manual.
        const after = JSON.parse(await fs.readFile(modelsFile, 'utf8'));
        assert.deepEqual(after.providers, {
          manual: HAND_WRITTEN_PROVIDER,
          ...(savedA ? {
            'box-a': {
              baseUrl: savedA.baseUrl,
              api: 'openai-completions',
              apiKey: savedA.apiKey || 'local',
              ...(savedA.headers ? { headers: savedA.headers } : {}),
              models: SAVED_MANUAL_MODELS.map((m) => ({
                ...m,
                input: ['text'],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              })),
            },
          } : {}),
        });
      },
    );
  });
}

test('automatic listing and thinking discovery use configured literal auth/tenant headers', async () => {
  const received: Array<{ path: string; headers: http.IncomingHttpHeaders }> = [];
  const headers = { 'X-Api-Key': 'literal-secret', 'X-Tenant': 'tenant-a', authorization: 'Custom auth' };
  const authorized = (req: http.IncomingMessage) => {
    received.push({ path: req.url!, headers: req.headers });
    return req.headers['x-api-key'] === headers['X-Api-Key'] &&
      req.headers['x-tenant'] === headers['X-Tenant'] && req.headers.authorization === headers.authorization;
  };
  await withEndpoint(
    (req) => authorized(req) ? { status: 400, body: NINFER_ERROR } : { status: 403, body: 'missing headers' },
    async (baseUrl) => {
      const box: PiProvider = { id: 'box-headers', baseUrl, apiKey: 'default-key', headers, models: [] };
      await updateGlobalSettings({ piProviders: [box] });
      assert.equal(await refreshEndpointDiscovery({ force: true }), true);
      const after = (await getGlobalSettings()).piProviders!;
      assert.deepEqual(after, [{ ...box, models: [{
        id: 'm1', contextWindow: 4096,
        thinkingLevels: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
      }] }]);
      assert.deepEqual(received.map((r) => r.path), ['/v1/models', '/v1/chat/completions']);
      assert.equal(received[1].headers['content-type'], 'application/json');
    },
    (req) => authorized(req)
      ? { status: 200, body: '{"data":[{"id":"m1","max_model_len":4096}]}' }
      : { status: 403, body: 'missing headers' },
  );
});

test('a header edit during model listing discards both listing and subsequent capability results', async () => {
  const started = deferred<void>();
  const listing = deferred<ChatReply>();
  const received: http.IncomingHttpHeaders[] = [];
  await withEndpoint(
    (req) => {
      received.push(req.headers);
      return { status: 400, body: NINFER_ERROR };
    },
    async (baseUrl) => {
      const box: PiProvider = { id: 'box-listing', baseUrl, headers: { 'X-Tenant': 'A' }, models: [] };
      await updateGlobalSettings({ piProviders: [box] });
      const refresh = refreshEndpointDiscovery({ force: true });
      const edited = { ...box, headers: { 'X-Tenant': 'B' }, models: SAVED_MANUAL_MODELS };
      let changed = false;
      try {
        await Promise.race([
          started.promise,
          refresh.then(() => assert.fail('sweep settled before the listing arrived')),
        ]);
        await updateGlobalSettings({ piProviders: [edited] });
      } finally {
        listing.resolve({ status: 200, body: '{"data":[{"id":"m1","max_model_len":4096}]}' });
        changed = await refresh;
      }
      assert.equal(changed, false);
      assert.deepEqual((await getGlobalSettings()).piProviders, [edited]);
      assert.equal(received.length, 2);
      assert.ok(received.every((h) => h['x-tenant'] === 'A'), 'all probes use the starting snapshot');
      const models = JSON.parse(await fs.readFile(path.join(os.homedir(), '.pi', 'agent', 'models.json'), 'utf8'));
      assert.deepEqual(models.providers['box-listing'].headers, edited.headers);
      assert.ok(models.providers['box-listing'].models.every((m: { thinkingLevelMap?: unknown }) => !m.thinkingLevelMap));
    },
    (req) => {
      received.push(req.headers);
      started.resolve();
      return listing.promise;
    },
  );
});

for (const { name, thinkingLevels } of [
  { name: 'explicit effort levels', thinkingLevels: ['low', 'max'] },
  { name: 'the ordinary [] marker', thinkingLevels: [] },
]) {
  test(`an in-flight capability probe preserves saved metadata and ${name}`, async () => {
    const probeStarted = deferred<void>();
    const reply = deferred<ChatReply>();
    await withEndpoint(
      () => {
        probeStarted.resolve();
        return reply.promise;
      },
      async (baseUrl) => {
        const boxA: PiProvider = {
          id: 'box-a', baseUrl, autoDiscover: true,
          models: [{ id: 'm1', name: 'Old name', contextWindow: 1024, maxTokens: 128 }],
        };
        const modelsFile = await seedHandWrittenProvider();
        await updateGlobalSettings({ piProviders: [boxA] });
        await reconcilePiModelsJson();

        const savedModel = {
          id: 'm1', name: 'Fresh friendly name', contextWindow: 8192, maxTokens: 512,
          thinkingLevels,
        };
        const savedA = { ...boxA, models: [savedModel] };
        const refresh = refreshEndpointDiscovery({ force: true });
        let changed = false;
        try {
          await Promise.race([
            probeStarted.promise,
            refresh.then(() => assert.fail('sweep settled before its capability probe arrived')),
          ]);
          await updateGlobalSettings({ piProviders: [savedA] });
        } finally {
          reply.resolve({ status: 400, body: NINFER_ERROR });
          changed = await refresh;
        }

        assert.equal(changed, true, 'the valid listing supplies an authoritative context window');
        assert.deepEqual((await getGlobalSettings()).piProviders, [{
          ...savedA,
          models: [{ ...savedModel, contextWindow: 4096 }],
        }], 'fresh name, maxTokens and thinkingLevels must win over the probe snapshot');
        const after = JSON.parse(await fs.readFile(modelsFile, 'utf8'));
        assert.deepEqual(after.providers, {
          manual: HAND_WRITTEN_PROVIDER,
          'box-a': {
            baseUrl,
            api: 'openai-completions',
            apiKey: 'local',
            models: [{
              id: 'm1', name: 'Fresh friendly name', contextWindow: 4096, maxTokens: 512,
              input: ['text'],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              ...(thinkingLevels.length ? {
                reasoning: true,
                thinkingLevelMap: {
                  off: null, minimal: null, low: 'low', medium: null,
                  high: null, xhigh: null, max: 'max',
                },
              } : {}),
            }],
          },
        });
      },
    );
  });
}

test('a probe with no answer leaves the model unprobed (no `thinkingLevels: []` marker)', async () => {
  await withEndpoint(
    () => ({ status: 503, body: 'upstream restarting' }),
    async (baseUrl) => {
      const boxA: PiProvider = { id: 'box-a', baseUrl, autoDiscover: true, models: [] };
      await updateGlobalSettings({ piProviders: [boxA] });
      await refreshEndpointDiscovery({ force: true });
      const a = ((await getGlobalSettings()).piProviders ?? []).find((p) => p.id === 'box-a')!;
      // The model listing landed, but nothing was recorded about its levels —
      // a 503 says the server was down, not that the model is ordinary.
      assert.deepEqual(a.models, [{ id: 'm1', contextWindow: 4096 }]);
    },
  );
});

test('probeThinkingLevels: tokens on an enumerating 400, [] on a 2xx, null on everything else', async () => {
  await withEndpoint(
    () => ({ status: 400, body: NINFER_ERROR }),
    async (baseUrl) => {
      assert.deepEqual(await probeThinkingLevels(baseUrl, undefined, 'm1'), [
        'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max',
      ]);
    },
  );
  // 2xx: the server accepted the nonsense value → "validates nothing", a real
  // answer that is worth recording so the model isn't asked every sweep.
  await withEndpoint(
    () => ({ status: 200, body: '{"choices":[]}' }),
    async (baseUrl) => {
      assert.deepEqual(await probeThinkingLevels(baseUrl, undefined, 'm1'), []);
    },
  );
  // A rejection that enumerates nothing recognizable → no answer.
  await withEndpoint(
    () => ({ status: 400, body: '{"error":"reasoning_effort is not supported"}' }),
    async (baseUrl) => {
      assert.equal(await probeThinkingLevels(baseUrl, undefined, 'm1'), null);
    },
  );
  // A status that isn't a validation rejection → no answer (a 401 from a
  // `$VAR` key the probe never resolves is the everyday case).
  await withEndpoint(
    () => ({ status: 401, body: '{"error":"unauthorized"}' }),
    async (baseUrl) => {
      assert.equal(await probeThinkingLevels(baseUrl, undefined, 'm1'), null);
    },
  );
  // Network error (nothing listening) → no answer.
  assert.equal(await probeThinkingLevels('http://127.0.0.1:9/v1', undefined, 'm1'), null);
});

// Regression: sanitizeThinkingLevels mapped the `[]` "probed, ordinary" marker
// to undefined, so it never survived the settings round-trip — every sweep
// re-sent the capability probe and rewrote globalSettings.json.
test('an ordinary model is probed once: the [] marker survives the settings round-trip', async () => {
  let chats = 0;
  await withEndpoint(
    () => {
      chats += 1;
      return { status: 200, body: '{"choices":[]}' };
    },
    async (baseUrl) => {
      const boxA: PiProvider = { id: 'box-a', baseUrl, autoDiscover: true, models: [] };
      await updateGlobalSettings({ piProviders: [boxA] });
      assert.equal(await refreshEndpointDiscovery({ force: true }), true);
      const a = ((await getGlobalSettings()).piProviders ?? []).find((p) => p.id === 'box-a')!;
      assert.deepEqual(a.models, [{ id: 'm1', contextWindow: 4096, thinkingLevels: [] }]);
      assert.equal(chats, 1);
      assert.equal(await refreshEndpointDiscovery({ force: true }), false, 'nothing changed');
      assert.equal(chats, 1, 'the model was not probed again');
    },
  );
});

test('sanitizePiProviders drops prototype-key and slash-bearing provider ids', () => {
  const out = sanitizePiProviders([
    { id: '__proto__', baseUrl: 'http://h/v1', models: [] },
    { id: 'a/b', baseUrl: 'http://h/v1', models: [] },
    { id: 'ok', baseUrl: 'http://h/v1', models: [] },
  ]);
  assert.deepEqual(out.map((p) => p.id), ['ok']);
});

// Regression: reconcile read globalSettings with the display fallback, so an
// unreadable/corrupt globalSettings.json read as "no providers" and every
// managed provider was deleted from models.json.
test('reconcile leaves models.json alone when globalSettings.json is corrupt', async () => {
  const boxA: PiProvider = { id: 'box-a', baseUrl: 'http://127.0.0.1:9/v1', autoDiscover: false, models: [{ id: 'm' }] };
  await updateGlobalSettings({ piProviders: [boxA] });
  await reconcilePiModelsJson();
  const modelsFile = path.join(os.homedir(), '.pi', 'agent', 'models.json');
  const before = await fs.readFile(modelsFile, 'utf8');
  assert.ok(JSON.parse(before).providers['box-a'], 'managed provider reconciled in');

  const settingsFile = path.join(os.homedir(), '.lattice', 'globalSettings.json');
  const good = await fs.readFile(settingsFile, 'utf8');
  await fs.writeFile(settingsFile, '{"piProviders": [');
  try {
    await reconcilePiModelsJson();
    assert.equal(await fs.readFile(modelsFile, 'utf8'), before, 'models.json untouched');
  } finally {
    await fs.writeFile(settingsFile, good);
  }
});
