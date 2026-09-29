import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import type { PiProvider } from '../api';
import {
  useEndpointState,
  usePiEndpointEditors,
  useProbeDetection,
} from '../components/settings/usePiEndpoints.ts';

// Regression: a slow "Detect models" probe started in a Settings session the
// user then cancelled resolved after the dialog was reopened. It replaced the
// endpoint's curated model list with every detected model and marked the draft
// touched, so the next unrelated Save wrote `piProviders` and discarded the
// curation. `useProbeDetection.reset()` (run on every open) now fences the old
// probe out: neither `setDetected` nor `onDetected` runs for it.

type FakeResponse = { ok: boolean; status: number; json: () => Promise<unknown> };

const g = globalThis as unknown as Record<string, unknown>;
let saved: Record<string, unknown>;
let probes: Array<{
  body: { baseUrl: string; apiKey?: string; headers?: Record<string, string> };
  resolve: (models: unknown) => void;
  reject: (msg: string) => void;
}>;

beforeEach(() => {
  probes = [];
  saved = { IS_REACT_ACT_ENVIRONMENT: g.IS_REACT_ACT_ENVIRONMENT, React: g.React, fetch: g.fetch };
  g.IS_REACT_ACT_ENVIRONMENT = true;
  g.React = React;
  g.fetch = (url: string, init: RequestInit) => {
    assert.ok(url.includes('/api/pi-endpoints/probe'), `unexpected fetch ${url}`);
    // Held until the test settles it — the slow endpoint.
    return new Promise<FakeResponse>((res) => {
      probes.push({
        body: JSON.parse(init.body as string),
        resolve: (models) =>
          res({ ok: true, status: 200, json: () => Promise.resolve({ models }) }),
        reject: (msg) =>
          res({ ok: false, status: 502, json: () => Promise.resolve({ error: msg }) }),
      });
    });
  };
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete g[k];
    else g[k] = v;
  }
});

const CURATED: PiProvider = {
  id: 'vllm',
  baseUrl: 'http://gpu:8000/v1',
  autoDiscover: false,
  models: [{ id: 'qwen' }],
};
const PROBED = [{ id: 'qwen' }, { id: 'llama' }, { id: 'mistral' }];

let endpoints!: ReturnType<typeof useEndpointState>;
let probe!: ReturnType<typeof useProbeDetection>;
let editors!: ReturnType<typeof usePiEndpointEditors>;
function Harness() {
  probe = useProbeDetection();
  endpoints = useEndpointState(probe.dropEndpoint);
  editors = usePiEndpointEditors(endpoints, probe, endpoints.providers);
  return null;
}

async function mount() {
  let renderer!: ReturnType<typeof TestRenderer.create>;
  await act(async () => {
    renderer = TestRenderer.create(React.createElement(Harness));
  });
  // What PiTab's open effect does once the saved settings load.
  await act(async () => {
    endpoints.setProviders([CURATED]);
    probe.seed([CURATED]);
    endpoints.setLoaded(true);
  });
  return renderer;
}

async function flush() {
  await act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  });
}

test('a probe from a reset (closed) Settings session never lands', async () => {
  const renderer = await mount();

  let detectDone!: Promise<void> | undefined;
  await act(async () => {
    detectDone = editors.detectModels(0);
  });
  assert.equal(probes.length, 1);
  assert.equal(probe.probing.vllm, true);

  // Cancel + reopen: PiTab's open effect resets the probe state and the touched
  // flag, then reloads the saved list.
  await act(async () => {
    endpoints.setTouched(false);
    probe.reset();
    endpoints.setProviders([CURATED]);
    probe.seed([CURATED]);
  });

  await act(async () => {
    probes[0].resolve(PROBED);
    await detectDone;
  });
  await flush();

  assert.deepEqual(endpoints.providers, [CURATED], 'the curated models must survive');
  assert.equal(endpoints.touched, false, 'the draft must not be marked touched');
  assert.deepEqual(probe.detected, { vllm: [{ id: 'qwen' }] }, 'detected keeps the seeded list');
  assert.deepEqual(probe.probing, {}, 'the stale probe writes nothing into the new session');
  assert.deepEqual(probe.probeError, {});

  await act(async () => {
    renderer.unmount();
  });
});

test('a stale probe calls neither setDetected nor onDetected, even when it fails', async () => {
  const renderer = await mount();
  let calls = 0;

  let first!: Promise<void>;
  let second!: Promise<void>;
  await act(async () => {
    first = probe.detect('vllm', CURATED, () => calls++);
    second = probe.detect('vllm', CURATED, () => calls++);
  });
  await act(async () => {
    probe.reset();
  });
  await act(async () => {
    probes[0].resolve(PROBED);
    probes[1].reject('connection refused');
    await first;
    await second;
  });
  await flush();

  assert.equal(calls, 0, 'onDetected must not run for a stale probe');
  assert.deepEqual(probe.detected, {});
  assert.deepEqual(probe.probeError, {}, 'a stale failure must not surface either');
  assert.deepEqual(endpoints.providers, [CURATED]);

  await act(async () => {
    renderer.unmount();
  });
});

// Control: within one session the same probe does apply — so the tests above
// exercise a result that would otherwise have landed.
test('a probe in the current session replaces the model list and marks touched', async () => {
  const renderer = await mount();

  let detectDone!: Promise<void> | undefined;
  await act(async () => {
    detectDone = editors.detectModels(0);
  });
  await act(async () => {
    probes[0].resolve(PROBED);
    await detectDone;
  });
  await flush();

  assert.deepEqual(
    endpoints.providers[0].models.map((m) => m.id),
    ['qwen', 'llama', 'mistral'],
  );
  assert.equal(endpoints.touched, true);
  assert.deepEqual(probe.detected.vllm, PROBED);
  assert.equal(probe.probing.vllm, false);

  await act(async () => {
    renderer.unmount();
  });
});

for (const field of ['baseUrl', 'apiKey', 'id', 'headers'] as const) {
  for (const restore of [false, true]) {
    test(`same-open ${field} edit${restore ? ' and restoration' : ''} invalidates Detect`, async () => {
      const renderer = await mount();
      const original = { ...CURATED, apiKey: 'literal-key', headers: { 'X-Tenant': 'A' } };
      await act(async () => { endpoints.setProviders([original]); probe.seed([original]); });
      let done!: Promise<void> | undefined;
      await act(async () => { done = editors.detectModels(0); });
      assert.deepEqual(probes[0].body, {
        baseUrl: original.baseUrl, apiKey: original.apiKey, headers: original.headers,
      }, 'the manual API receives the full literal request snapshot');
      await act(async () => {
        if (field === 'headers') editors.updateHeaderValue(0, 0, 'B');
        else endpoints.patch(0, { [field]: 'replacement' });
        // Restore in the SAME React batch: equality at response time must not
        // resurrect a request whose configuration changed in between.
        if (restore) endpoints.patch(0, { [field]: original[field] });
        endpoints.setTouched(false);
      });
      const edited = endpoints.providers;
      assert.equal(probe.probing.vllm, undefined, 'editing frees the Detect button');
      await act(async () => { probes[0].resolve(PROBED); await done; });
      assert.deepEqual(endpoints.providers, edited);
      assert.equal(endpoints.touched, false, 'old models do not mark the draft touched');
      assert.deepEqual(probe.detected, {});
      assert.deepEqual(probe.probeError, {});
      assert.deepEqual(probe.probing, {});
      await act(async () => { renderer.unmount(); });
    });
  }
}

for (const fails of [false, true]) {
  test(`removed/readded id reuse fences old ${fails ? 'failure' : 'success'} and cleanup`, async () => {
    const renderer = await mount();
    const original = { ...CURATED, id: 'endpoint-1' };
    await act(async () => { endpoints.setProviders([original]); probe.seed([original]); });
    let old!: Promise<void> | undefined;
    let fresh!: Promise<void> | undefined;
    await act(async () => { old = editors.detectModels(0); });
    await act(async () => {
      endpoints.remove(0);
      endpoints.add();
      endpoints.patch(0, { baseUrl: original.baseUrl, autoDiscover: false });
      fresh = editors.detectModels(0);
      endpoints.setTouched(false);
    });
    assert.equal(endpoints.providers[0].id, original.id);
    assert.equal(probe.probing['endpoint-1'], true);
    await act(async () => {
      if (fails) probes[0].reject('obsolete failure');
      else probes[0].resolve(PROBED);
      await old;
    });
    assert.deepEqual(endpoints.providers[0].models, []);
    assert.equal(endpoints.touched, false);
    assert.equal(probe.probing['endpoint-1'], true, 'old finally cannot settle the new probe');
    assert.deepEqual(probe.detected, {});
    assert.equal(probe.probeError['endpoint-1'], '');
    await act(async () => { probes[1].resolve([{ id: 'current' }]); await fresh; });
    assert.deepEqual(endpoints.providers[0].models, [{ id: 'current' }]);
    assert.equal(probe.probing['endpoint-1'], false);
    assert.equal(endpoints.touched, true);
    await act(async () => { renderer.unmount(); });
  });

  for (const newestSettlesFirst of [false, true]) {
    test(`overlapping Detect ignores old ${fails ? 'failure' : 'success'} (${newestSettlesFirst ? 'newer settled' : 'newer pending'})`, async () => {
      const renderer = await mount();
      let old!: Promise<void> | undefined;
      let fresh!: Promise<void> | undefined;
      await act(async () => {
        old = editors.detectModels(0);
        fresh = editors.detectModels(0);
      });
      const settleFresh = async () => {
        await act(async () => { probes[1].resolve([{ id: 'current' }]); await fresh; });
      };
      if (newestSettlesFirst) await settleFresh();
      await act(async () => {
        if (fails) probes[0].reject('obsolete failure');
        else probes[0].resolve(PROBED);
        await old;
      });
      assert.equal(probe.probing.vllm, !newestSettlesFirst);
      assert.equal(probe.probeError.vllm, '');
      assert.deepEqual(endpoints.providers[0].models,
        newestSettlesFirst ? [{ id: 'current' }] : CURATED.models);
      assert.deepEqual(probe.detected.vllm,
        newestSettlesFirst ? [{ id: 'current' }] : [{ id: 'qwen' }]);
      if (!newestSettlesFirst) await settleFresh();
      assert.deepEqual(endpoints.providers[0].models, [{ id: 'current' }]);
      await act(async () => { renderer.unmount(); });
    });
  }
}

test('a current probe survives earlier-row removal and preserves freshly edited metadata', async () => {
  const renderer = await mount();
  const earlier = { ...CURATED, id: 'earlier' };
  await act(async () => { endpoints.setProviders([earlier, CURATED]); probe.seed([earlier, CURATED]); });
  let done!: Promise<void> | undefined;
  await act(async () => { done = editors.detectModels(1); });
  await act(async () => {
    endpoints.remove(0);
    endpoints.patch(0, { models: [{ id: 'qwen', name: 'Fresh name', maxTokens: 512, thinkingLevels: ['max'] }] });
  });
  await act(async () => { probes[0].resolve([{ id: 'qwen', contextWindow: 8192 }]); await done; });
  assert.deepEqual(endpoints.providers, [{ ...CURATED, models: [{
    id: 'qwen', name: 'Fresh name', maxTokens: 512, thinkingLevels: ['max'], contextWindow: 8192,
  }] }]);
  assert.equal(probe.probing.vllm, false);
  await act(async () => { renderer.unmount(); });
});

test('unmount fences pending Detect callbacks', async () => {
  const renderer = await mount();
  let calls = 0;
  let done!: Promise<void>;
  await act(async () => { done = probe.detect(CURATED.id, CURATED, () => calls++); });
  await act(async () => { renderer.unmount(); });
  probes[0].resolve(PROBED);
  await done;
  assert.equal(calls, 0);
});

test('a current Detect failure reports its error and settles its busy flag', async () => {
  const renderer = await mount();
  let done!: Promise<void> | undefined;
  await act(async () => { done = editors.detectModels(0); });
  await act(async () => { probes[0].reject('current failure'); await done; });
  assert.equal(probe.probeError.vllm, 'current failure');
  assert.equal(probe.probing.vllm, false);
  assert.deepEqual(endpoints.providers, [CURATED]);
  assert.equal(endpoints.touched, false);
  await act(async () => { renderer.unmount(); });
});

test('a replacement row receives nothing from a removed row even without a new Detect', async () => {
  const renderer = await mount();
  await act(async () => { endpoints.setProviders([{ ...CURATED, id: 'endpoint-1' }]); });
  let done!: Promise<void> | undefined;
  await act(async () => { done = editors.detectModels(0); });
  await act(async () => {
    endpoints.remove(0);
    endpoints.add();
    endpoints.patch(0, { baseUrl: CURATED.baseUrl, autoDiscover: false });
    endpoints.setTouched(false);
  });
  await act(async () => { probes[0].resolve(PROBED); await done; });
  assert.deepEqual(endpoints.providers[0].models, []);
  assert.equal(endpoints.touched, false);
  assert.deepEqual(probe.detected, {});
  assert.deepEqual(probe.probeError, {});
  assert.deepEqual(probe.probing, {});
  await act(async () => { renderer.unmount(); });
});
