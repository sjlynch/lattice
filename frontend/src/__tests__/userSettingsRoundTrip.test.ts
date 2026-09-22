import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { useUserSettings, type UserSettingsResult } from '../hooks/useUserSettings.ts';
import type { UserSettings } from '../api';

// Regression: the fetched result was stamped with its folder only, so an
// A→B→A switch made before B's fetch landed found `fetched` still stamped A and
// served A's OLD snapshot as `loaded: true` until A's refetch returned — values
// PATCHed while A was last active (startup terminals, restore mode) came back
// pre-PATCH for that window. Returning to A must read as "not loaded" until the
// fresh fetch answers.

const A = 'C:/development/project-A';
const B = 'C:/development/project-B';

const g = globalThis as unknown as Record<string, unknown>;
let saved: Record<string, unknown>;
let aFetches: number;
let releaseSecondA: () => void;
let observed: UserSettingsResult[];

beforeEach(() => {
  aFetches = 0;
  observed = [];
  const secondA = new Promise<void>((res) => {
    releaseSecondA = res;
  });
  saved = {
    IS_REACT_ACT_ENVIRONMENT: g.IS_REACT_ACT_ENVIRONMENT,
    React: g.React,
    fetch: g.fetch,
  };
  g.IS_REACT_ACT_ENVIRONMENT = true;
  g.React = React;
  g.fetch = (url: string) => {
    if (url.includes('project-A')) {
      aFetches += 1;
      const body: UserSettings = { sidebarWidth: aFetches === 1 ? 300 : 420 };
      const gate = aFetches === 1 ? Promise.resolve() : secondA;
      return gate.then(() => ({ ok: true, json: () => Promise.resolve(body) }));
    }
    // B never answers within the test.
    return new Promise(() => {});
  };
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete g[k];
    else g[k] = v;
  }
});

function Harness({ folder }: { folder: string }) {
  observed.push(useUserSettings(folder));
  return null;
}

async function flush() {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

test("an A→B→A switch never serves A's previous snapshot as loaded", async () => {
  let renderer!: ReturnType<typeof TestRenderer.create>;
  const tree = (folder: string) => React.createElement(Harness, { folder });

  await act(async () => {
    renderer = TestRenderer.create(tree(A));
  });
  await act(async () => {
    await flush();
  });
  assert.deepEqual(observed.at(-1), { settings: { sidebarWidth: 300 }, loaded: true });

  await act(async () => {
    renderer.update(tree(B));
  });
  const beforeReturn = observed.length;
  await act(async () => {
    renderer.update(tree(A));
  });
  await act(async () => {
    await flush();
  });

  for (const row of observed.slice(beforeReturn)) {
    assert.equal(row.loaded, false, 'the stale A snapshot must not read as loaded');
  }

  await act(async () => {
    releaseSecondA();
    await flush();
  });
  assert.deepEqual(observed.at(-1), { settings: { sidebarWidth: 420 }, loaded: true });

  act(() => renderer.unmount());
});
