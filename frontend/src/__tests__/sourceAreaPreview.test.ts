// Late scans must never seed a replacement editor, including A -> B -> A.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import React, { act } from 'react';
import TestRenderer from 'react-test-renderer';
import { useSourceAreaPreview } from '../components/workflows/hooks/useSourceAreaPreview';
import type { WorkflowStep } from '../api';
import { installGlobal } from './domDoubles';
const delay = () => new Promise((resolve) => setTimeout(resolve, 180));
test('preview and tree responses are fenced by editor, project, config and unmount', async () => {
  const requests: { url: string; resolve: (value: unknown) => void }[] = [];
  const restores = [installGlobal('IS_REACT_ACT_ENVIRONMENT', true), installGlobal('fetch', (url: string) => new Promise((resolve) => requests.push({ url, resolve: (v) => resolve({ ok: true, json: async () => v }) })))];
  let latest!: ReturnType<typeof useSourceAreaPreview>;
  const split: NonNullable<WorkflowStep['split']> = { mode: 'auto', count: 10 };
  function Probe({ project, identity, config = split }: { project: string; identity: symbol; config?: typeof split }) {
    latest = useSourceAreaPreview(project, identity, config); return null;
  }
  let renderer!: TestRenderer.ReactTestRenderer;
  const first = Symbol(), second = Symbol();
  const tree = { path: '.', name: '.', files: 1, weight: 1, children: [] };
  const preview = { areas: [{ paths: ['src'], files: 20, weight: 20, label: 'src' }], totalFiles: 20 };
  try {
    await act(async () => { renderer = TestRenderer.create(React.createElement(Probe, { project: 'A', identity: first })); });
    await act(delay);
    const old = [...requests];
    await act(async () => { renderer.update(React.createElement(Probe, { project: 'B', identity: first })); });
    await act(async () => { renderer.update(React.createElement(Probe, { project: 'A', identity: second })); });
    await act(async () => { for (const r of old) r.resolve(r.url.includes('source-tree') ? tree : preview); });
    assert.equal(latest.preview, undefined as typeof latest.preview); assert.equal(latest.tree, undefined as typeof latest.tree);
    await act(delay);
    await act(async () => { for (const r of requests.slice(-2)) r.resolve(r.url.includes('source-tree') ? tree : preview); });
    assert.equal(latest.preview?.areas[0].label, 'src'); assert.equal(latest.tree?.files, 1);
    await act(async () => { renderer.update(React.createElement(Probe, { project: 'A', identity: second, config: { mode: 'auto', count: 4 } })); });
    assert.equal(latest.preview, undefined, 'changing count hides the old preview before another response');
    await act(delay);
    const final = requests.at(-1)!;
    act(() => renderer.unmount());
    await act(async () => final.resolve(preview));
  } finally { if (renderer) act(() => renderer.unmount()); for (const restore of restores.reverse()) restore(); }
});
