import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import type { Workflow } from '../api';
import { useWorkflowEditor } from '../components/workflows/hooks/useWorkflowEditor.ts';

// REGRESSION: on a never-saved draft `editor.workflowId` is null in both click
// closures of a double-clicked Create (or ▶ Run / Queue, which save first), so
// each click used to POST /api/workflows and two identical definitions
// appeared. `save()` is now single-flight: a call while a save is pending gets
// the same promise.

const g = globalThis as unknown as Record<string, unknown>;
let saved: Record<string, unknown>;
let creates: number;
let resolveCreate: ((wf: Workflow) => void) | null;

function workflow(): Workflow {
  return {
    id: 'wf_new',
    name: 'Untitled workflow',
    projectPath: 'C:/p',
    steps: [],
    variables: [],
    createdAt: 0,
  };
}

beforeEach(() => {
  creates = 0;
  resolveCreate = null;
  saved = { IS_REACT_ACT_ENVIRONMENT: g.IS_REACT_ACT_ENVIRONMENT, fetch: g.fetch };
  g.IS_REACT_ACT_ENVIRONMENT = true;
  g.fetch = (url: string, init?: { method?: string }) => {
    if (url === '/api/workflows' && init?.method === 'POST') {
      creates += 1;
      return new Promise((resolve) => {
        resolveCreate = (wf) =>
          resolve({ ok: true, status: 200, json: () => Promise.resolve(wf) });
      });
    }
    return Promise.reject(new Error(`unexpected fetch ${url}`));
  };
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete g[k];
    else g[k] = v;
  }
});

let latest!: ReturnType<typeof useWorkflowEditor>;
const errors: string[] = [];
function Harness() {
  latest = useWorkflowEditor({
    workflows: [],
    activeFolder: 'C:/p',
    onError: (msg) => errors.push(msg),
    onStepsAdded: () => {},
  });
  return null;
}

test('a double-clicked Create on a draft creates one workflow', async () => {
  let renderer!: ReturnType<typeof TestRenderer.create>;
  await act(async () => {
    renderer = TestRenderer.create(React.createElement(Harness));
  });
  act(() => latest.newBlank());
  assert.equal(latest.editor.workflowId, null, 'a never-saved draft');

  // Both clicks share the same closure — neither sees a workflow id.
  const save = latest.save;
  let p1!: Promise<Workflow | null>;
  let p2!: Promise<Workflow | null>;
  await act(async () => {
    p1 = save();
    p2 = save();
    await Promise.resolve();
  });
  assert.equal(latest.saving, true, 'Save is disabled while the create is in flight');
  // A click after the re-render (a fresh `save` identity) joins it too.
  let p3!: Promise<Workflow | null>;
  await act(async () => {
    p3 = latest.save();
    await Promise.resolve();
  });
  assert.equal(creates, 1, 'one create request');

  const created = workflow();
  let results!: Array<Workflow | null>;
  await act(async () => {
    resolveCreate!(created);
    results = await Promise.all([p1, p2, p3]);
  });
  assert.equal(creates, 1);
  assert.deepEqual(results, [created, created, created], 'every caller gets the same workflow');
  assert.equal(latest.saving, false, 'released once the save settles');
  assert.deepEqual(errors, []);
  act(() => renderer.unmount());
});
