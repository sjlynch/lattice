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
let probes: Array<{ resolve: (models: unknown) => void; reject: (msg: string) => void }>;

beforeEach(() => {
  probes = [];
  saved = { IS_REACT_ACT_ENVIRONMENT: g.IS_REACT_ACT_ENVIRONMENT, React: g.React, fetch: g.fetch };
  g.IS_REACT_ACT_ENVIRONMENT = true;
  g.React = React;
  g.fetch = (url: string) => {
    assert.ok(url.includes('/api/pi-endpoints/probe'), `unexpected fetch ${url}`);
    // Held until the test settles it — the slow endpoint.
    return new Promise<FakeResponse>((res) => {
      probes.push({
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
  endpoints = useEndpointState();
  probe = useProbeDetection();
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
