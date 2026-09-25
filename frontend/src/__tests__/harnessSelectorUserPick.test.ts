import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { FakeWebSocket } from './domDoubles.ts';
import { useHarnessSelector } from '../components/taskboard/hooks/useHarnessSelector.ts';

// Regression: a harness picked while the board's settings load is in flight was
// reverted in the UI but stayed saved. The GET began before the pick's PATCH, so
// it returned the OLD harness and `setHarness('claude')` overwrote the choice —
// the dropdown showed Claude and Run All spawned Claude, while a reload showed
// Pi. `selectHarness` now claims the next load id, so that GET reads as stale.
//
// Drives the real hook headlessly: availability arrives over the (fake)
// `/ws/harnesses` socket, which starts the settings GET; we hold that GET,
// pick "Pi — vllm/qwen", then let the GET return the old `claude`.

type FakeResponse = { ok: boolean; status: number; json: () => Promise<unknown> };

const g = globalThis as unknown as Record<string, unknown>;
let saved: Record<string, unknown>;
let settingsGets: Array<(body: unknown) => void>;
let patches: Array<{ url: string; body: unknown }>;

function ok(body: unknown): FakeResponse {
  return { ok: true, status: 200, json: () => Promise.resolve(body) };
}

beforeEach(() => {
  FakeWebSocket.instances = [];
  settingsGets = [];
  patches = [];
  saved = {
    IS_REACT_ACT_ENVIRONMENT: g.IS_REACT_ACT_ENVIRONMENT,
    React: g.React,
    WebSocket: g.WebSocket,
    window: g.window,
    document: g.document,
    fetch: g.fetch,
  };
  g.IS_REACT_ACT_ENVIRONMENT = true;
  g.React = React;
  g.WebSocket = FakeWebSocket;
  g.window = {
    location: { protocol: 'http:', host: 'localhost:5184' },
    addEventListener() {},
    removeEventListener() {},
  };
  g.document = { addEventListener() {}, removeEventListener() {} };
  g.fetch = (url: string, init?: { method?: string; body?: string }) => {
    if (url.includes('/api/pi-models')) return Promise.resolve(ok({ models: [], menu: [] }));
    if (url.includes('/api/settings')) {
      if (init?.method === 'PATCH') {
        patches.push({ url, body: JSON.parse(init.body ?? '{}') });
        return Promise.resolve(ok({}));
      }
      // Held until the test resolves it — the "in flight" settings load.
      return new Promise<FakeResponse>((res) => {
        settingsGets.push((body) => res(ok(body)));
      });
    }
    return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) });
  };
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete g[k];
    else g[k] = v;
  }
});

let latest!: ReturnType<typeof useHarnessSelector>;
function Harness({ folder }: { folder: string }) {
  latest = useHarnessSelector(folder);
  return null;
}

async function flush() {
  await act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  });
}

function deliverAvailability() {
  const ws = FakeWebSocket.instances.find((s) => s.url.includes('/ws/harnesses'));
  assert.ok(ws, 'the hook subscribes to /ws/harnesses');
  ws.onmessage?.({ data: JSON.stringify({ claude: true, pi: true, codex: false }) });
}

test('a harness picked while the settings load is in flight survives that load resolving', async () => {
  let renderer!: ReturnType<typeof TestRenderer.create>;
  await act(async () => {
    renderer = TestRenderer.create(React.createElement(Harness, { folder: 'C:/proj' }));
  });
  await act(async () => {
    deliverAvailability();
  });
  await flush();
  assert.equal(settingsGets.length, 1, 'availability starts the settings load');

  // The user picks "Pi — vllm/qwen" while that GET is still pending.
  await act(async () => {
    latest.selectHarness('pi:vllm/qwen');
  });
  assert.equal(latest.harness, 'pi');
  assert.deepEqual(patches.map((p) => p.body), [{ harness: 'pi', piModel: 'vllm/qwen' }]);

  // The GET (begun before the PATCH) now returns the OLD saved harness.
  await act(async () => {
    settingsGets[0]({ harness: 'claude' });
  });
  await flush();

  assert.equal(latest.harness, 'pi', 'the in-flight load must not revert the pick');
  assert.equal(latest.piModel, 'vllm/qwen', 'the in-flight load must not clear the picked model');
  assert.deepEqual(latest.pickRunHarness(), { harness: 'pi', piModel: 'vllm/qwen' });

  await act(async () => {
    renderer.unmount();
  });
});

// Control: without a pick, the same load does apply — so the test above
// exercises a load that would otherwise have landed.
test('with no pick, the settings load applies the saved harness', async () => {
  let renderer!: ReturnType<typeof TestRenderer.create>;
  await act(async () => {
    renderer = TestRenderer.create(React.createElement(Harness, { folder: 'C:/proj' }));
  });
  await act(async () => {
    deliverAvailability();
  });
  await flush();
  assert.equal(settingsGets.length, 1);

  await act(async () => {
    settingsGets[0]({ harness: 'pi', piModel: 'vllm/qwen' });
  });
  await flush();

  assert.equal(latest.harness, 'pi');
  assert.equal(latest.piModel, 'vllm/qwen');
  assert.equal(patches.length, 0);

  await act(async () => {
    renderer.unmount();
  });
});
