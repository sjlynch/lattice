import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import type { ScanResult, SearchResult } from '../api';
import {
  useGraphSearch,
  type SearchResult as SearchState,
} from '../components/forceGraph/hooks/useGraphSearch.ts';

// Regression for: graph content-search matches were a plain project-agnostic
// Set, so switching `activeFolder` (with the same query still active) briefly
// unioned the previous project's absolute file ids into the new project's
// selection before the passive contents effect could replace them. The fix
// tags each content result with the `{ project, query, regex }` scope it was
// produced for and ignores it unless that scope still matches the live inputs.

const CONTENT_DEBOUNCE_MS = 300;

type Resp = { ok: boolean; json: () => Promise<SearchResult> };

// Pending `fetch` resolvers keyed by the `project` query param of /api/search,
// so the test can settle each project's contents pass on its own schedule.
let pendingSearches: Record<string, ((r: Resp) => void)[]> = {};

function resolveSearch(project: string, matches: string[], truncated = false) {
  const queue = pendingSearches[project];
  assert.ok(queue && queue.length > 0, `expected a pending /api/search for ${project}`);
  const resolve = queue.shift()!;
  resolve({ ok: true, json: async () => ({ matches, scanned: matches.length, truncated }) });
}

// Build a distinct scan per project. The query ('match') hits exactly one file
// *name* in each project, and the file ids differ across the two — so the
// filename pass changes on the switch and can't be what makes A's ids linger.
function scanFor(root: string, matchFileId: string): ScanResult {
  return {
    root,
    nodes: [
      { id: root, name: root.split('/').pop()!, path: root, kind: 'dir' },
      { id: matchFileId, name: 'match_file.ts', path: matchFileId, kind: 'file', ext: '.ts' },
    ],
    links: [{ source: root, target: matchFileId }],
  };
}

const A_SCAN = scanFor('C:/projA', 'C:/projA/match_file.ts');
const B_SCAN = scanFor('C:/projB', 'C:/projB/match_file.ts');
// Pure content hits (not filename matches) — the ids that must not leak.
const A_CONTENT = ['C:/projA/deep/only_in_contents.ts'];
const B_CONTENT = ['C:/projB/deep/only_in_contents.ts'];

type Params = Parameters<typeof useGraphSearch>[0];

let latest: SearchState;
function Harness(props: Params) {
  latest = useGraphSearch(props);
  return null;
}

async function flushMicrotasks() {
  await act(async () => {
    for (let i = 0; i < 12; i += 1) await Promise.resolve();
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Let the debounce timer fire (calling `fetch`), without settling that fetch.
async function runDebounce() {
  await act(async () => {
    await sleep(CONTENT_DEBOUNCE_MS + 30);
  });
}

const g = globalThis as unknown as Record<string, unknown>;
let saved: Record<string, unknown>;

beforeEach(() => {
  saved = { IS_REACT_ACT_ENVIRONMENT: g.IS_REACT_ACT_ENVIRONMENT, fetch: g.fetch };
  g.IS_REACT_ACT_ENVIRONMENT = true;
  pendingSearches = {};
  g.fetch = (url: string) => {
    const project = new URL(url, 'http://localhost').searchParams.get('project') ?? '';
    return new Promise<Resp>((resolve) => {
      (pendingSearches[project] ??= []).push(resolve);
    });
  };
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete g[k];
    else g[k] = v;
  }
});

test('a project switch never selects the previous project\'s content matches', async () => {
  const calls: Set<string>[] = [];
  const setSelected = (next: Set<string>) => calls.push(next);
  const baseProps: Omit<Params, 'data' | 'activeFolder'> = {
    query: 'match',
    regex: false,
    contents: true,
    setSelected,
  };

  let renderer!: ReturnType<typeof TestRenderer.create>;
  await act(async () => {
    renderer = TestRenderer.create(
      React.createElement(Harness, {
        ...baseProps,
        data: A_SCAN,
        activeFolder: 'C:/projA',
      }),
    );
  });

  // Settle project A's contents pass — its content id now drives the selection.
  await runDebounce();
  await act(async () => {
    resolveSearch('C:/projA', A_CONTENT);
    await flushMicrotasks();
  });
  const preSwitch = calls.flatMap((s) => [...s]);
  assert.ok(
    preSwitch.includes('C:/projA/deep/only_in_contents.ts'),
    'sanity: A\'s content match should have been selected while A was active',
  );

  // --- switch active folder A → B, same query still active ---
  const switchIndex = calls.length;
  await act(async () => {
    renderer.update(
      React.createElement(Harness, {
        ...baseProps,
        data: B_SCAN,
        activeFolder: 'C:/projB',
      }),
    );
    await flushMicrotasks();
  });

  // Now settle B's own contents pass.
  await runDebounce();
  await act(async () => {
    resolveSearch('C:/projB', B_CONTENT);
    await flushMicrotasks();
  });

  // The regression: every selection pushed after the switch must be free of
  // project A ids (both the stale filename match and — the actual bug — the
  // stale content match).
  for (let i = switchIndex; i < calls.length; i += 1) {
    for (const id of calls[i]) {
      assert.ok(
        !id.startsWith('C:/projA/'),
        `setSelected call #${i} leaked a project A id after the switch: ${id}`,
      );
    }
  }

  // And the new project's own content match does land once it resolves in scope.
  const final = calls[calls.length - 1];
  assert.ok(
    final.has('C:/projB/deep/only_in_contents.ts'),
    'B\'s in-scope content match should be selected after B\'s pass resolves',
  );

  act(() => renderer.unmount());
});

test('a stale scope\'s truncated flag does not bleed into the new project', async () => {
  const setSelected = () => {};
  const baseProps: Omit<Params, 'data' | 'activeFolder'> = {
    query: 'match',
    regex: false,
    contents: true,
    setSelected,
  };

  let renderer!: ReturnType<typeof TestRenderer.create>;
  await act(async () => {
    renderer = TestRenderer.create(
      React.createElement(Harness, {
        ...baseProps,
        data: A_SCAN,
        activeFolder: 'C:/projA',
      }),
    );
  });

  await runDebounce();
  await act(async () => {
    resolveSearch('C:/projA', A_CONTENT, /* truncated */ true);
    await flushMicrotasks();
  });
  assert.equal(latest.status.truncated, true, 'A reported a truncated contents pass');

  // Switch to B before B's contents pass resolves: the still-present A result is
  // out of scope, so its truncated flag must read false for B immediately.
  await act(async () => {
    renderer.update(
      React.createElement(Harness, {
        ...baseProps,
        data: B_SCAN,
        activeFolder: 'C:/projB',
      }),
    );
    await flushMicrotasks();
  });
  assert.equal(
    latest.status.truncated,
    false,
    'A\'s truncated flag must not bleed into B before B\'s own pass resolves',
  );

  act(() => renderer.unmount());
});
