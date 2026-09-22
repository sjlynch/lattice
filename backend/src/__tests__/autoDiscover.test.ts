// Pi endpoint auto-discovery, end to end against a real local HTTP endpoint:
//   - a Settings save that lands WHILE a thinking-level probe is in flight
//     survives the sweep's write (the lost-update the re-read exists to stop);
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

// A minimal OpenAI-compatible endpoint: `/v1/models` lists one model and
// `/v1/chat/completions` answers whatever `onChat` decides (asynchronously, so
// a test can act while the request is pending).
async function withEndpoint<T>(
  onChat: () => Promise<ChatReply> | ChatReply,
  fn: (baseUrl: string) => Promise<T>,
): Promise<T> {
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/v1/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'm1', max_model_len: 4096 }] }));
      return;
    }
    if (req.method === 'POST' && req.url === '/v1/chat/completions') {
      req.on('data', () => {});
      req.on('end', () => {
        void Promise.resolve(onChat()).then((reply) => {
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
