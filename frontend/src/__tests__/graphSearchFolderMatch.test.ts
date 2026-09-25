import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import type { ScanResult } from '../api';
import {
  useGraphSearch,
  type SearchResult as SearchState,
} from '../components/forceGraph/hooks/useGraphSearch.ts';

// The search bar's name pass matches folder nodes as well as files, so a
// folder hit gets the same selection ring (and prev/next stop) as a file hit.

const ROOT = 'C:/proj';
const SCAN: ScanResult = {
  root: ROOT,
  nodes: [
    { id: ROOT, name: 'proj', path: ROOT, kind: 'dir' },
    { id: `${ROOT}/widgets`, name: 'widgets', path: `${ROOT}/widgets`, kind: 'dir' },
    {
      id: `${ROOT}/widgets/button.ts`,
      name: 'button.ts',
      path: `${ROOT}/widgets/button.ts`,
      kind: 'file',
      ext: '.ts',
    },
    {
      id: `${ROOT}/widget_util.ts`,
      name: 'widget_util.ts',
      path: `${ROOT}/widget_util.ts`,
      kind: 'file',
      ext: '.ts',
    },
  ],
  links: [
    { source: ROOT, target: `${ROOT}/widgets` },
    { source: `${ROOT}/widgets`, target: `${ROOT}/widgets/button.ts` },
    { source: ROOT, target: `${ROOT}/widget_util.ts` },
  ],
};

type Params = Parameters<typeof useGraphSearch>[0];

let latest: SearchState;
function Harness(props: Params) {
  latest = useGraphSearch(props);
  return null;
}

const g = globalThis as unknown as Record<string, unknown>;
let saved: unknown;

beforeEach(() => {
  saved = g.IS_REACT_ACT_ENVIRONMENT;
  g.IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  if (saved === undefined) delete g.IS_REACT_ACT_ENVIRONMENT;
  else g.IS_REACT_ACT_ENVIRONMENT = saved;
});

async function search(query: string): Promise<Set<string>[]> {
  const calls: Set<string>[] = [];
  let renderer!: ReturnType<typeof TestRenderer.create>;
  await act(async () => {
    renderer = TestRenderer.create(
      React.createElement(Harness, {
        data: SCAN,
        activeFolder: ROOT,
        query,
        regex: false,
        contents: false,
        setSelected: (next) => calls.push(next),
      }),
    );
  });
  await act(async () => renderer.unmount());
  return calls;
}

test('a query matching a folder name selects the folder node', async () => {
  const calls = await search('widgets');
  assert.deepEqual([...calls.at(-1)!].sort(), [`${ROOT}/widgets`]);
  assert.deepEqual(latest.matches, [`${ROOT}/widgets`]);
  assert.equal(latest.status.matchCount, 1);
});

test('folder and file name matches are unioned', async () => {
  const calls = await search('widget*');
  assert.deepEqual(
    [...calls.at(-1)!].sort(),
    [`${ROOT}/widget_util.ts`, `${ROOT}/widgets`],
  );
  assert.equal(latest.status.matchCount, 2);
});
