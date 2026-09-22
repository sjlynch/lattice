import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { useCollapsedSteps } from '../components/workflows/hooks/useCollapsedSteps.ts';

// Regressions for useCollapsedSteps' per-project load:
//  - a FAILED settings GET (a 502 while the backend restarts) used to read as
//    `{}` and count as loaded, so the next toggle PATCHed a
//    `workflowStepsCollapsed` map missing every step the project had
//    collapsed. A failed load now leaves persistence gated off.
//  - a project switch kept the previous project's map until the new load
//    landed.

const g = globalThis as unknown as Record<string, unknown>;
let saved: Record<string, unknown>;
let patches: Array<{ url: string; body: unknown }>;
let settingsFor: (url: string) => { ok: boolean; status: number; body: unknown };

beforeEach(() => {
  patches = [];
  saved = {
    IS_REACT_ACT_ENVIRONMENT: g.IS_REACT_ACT_ENVIRONMENT,
    fetch: g.fetch,
  };
  g.IS_REACT_ACT_ENVIRONMENT = true;
  g.fetch = (url: string, init?: { method?: string; body?: string }) => {
    if (init?.method === 'PATCH') {
      patches.push({ url, body: JSON.parse(init.body ?? '{}') });
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) });
    }
    const r = settingsFor(url);
    return Promise.resolve({ ok: r.ok, status: r.status, json: () => Promise.resolve(r.body) });
  };
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete g[k];
    else g[k] = v;
  }
});

let latest!: ReturnType<typeof useCollapsedSteps>;
function Harness({ folder }: { folder: string }) {
  latest = useCollapsedSteps(folder);
  return null;
}

async function flush() {
  await act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  });
}

test('a failed settings load does not let a toggle PATCH over the saved collapse map', async () => {
  settingsFor = () => ({ ok: false, status: 502, body: { error: 'bad gateway' } });
  let renderer!: ReturnType<typeof TestRenderer.create>;
  await act(async () => {
    renderer = TestRenderer.create(React.createElement(Harness, { folder: 'C:/project-A' }));
  });
  await flush();

  act(() => latest.toggleCollapsed('step-1'));
  assert.equal(latest.isCollapsed('step-1'), true, 'the toggle still applies locally');
  assert.equal(patches.length, 0, 'nothing is written over state that never loaded');
  act(() => renderer.unmount());
});

test("a project switch drops the previous project's collapse map", async () => {
  settingsFor = (url) =>
    url.includes('project-A')
      ? { ok: true, status: 200, body: { workflowStepsCollapsed: { 'a-step': true } } }
      : { ok: true, status: 200, body: {} };
  let renderer!: ReturnType<typeof TestRenderer.create>;
  await act(async () => {
    renderer = TestRenderer.create(React.createElement(Harness, { folder: 'C:/project-A' }));
  });
  await flush();
  assert.equal(latest.isCollapsed('a-step'), true);

  await act(async () => {
    renderer.update(React.createElement(Harness, { folder: 'C:/project-B' }));
  });
  assert.equal(latest.isCollapsed('a-step'), false);
  await flush();

  act(() => latest.toggleCollapsed('b-step'));
  assert.equal(patches.length, 1);
  assert.deepEqual(patches[0].body, { workflowStepsCollapsed: { 'b-step': true } });
  assert.ok(patches[0].url.includes('project-B'));
  act(() => renderer.unmount());
});
