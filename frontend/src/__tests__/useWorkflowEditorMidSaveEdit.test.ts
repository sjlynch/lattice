import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import type { Workflow, WorkflowStep } from '../api';
import { useWorkflowEditor } from '../components/workflows/hooks/useWorkflowEditor.ts';
import { fromWorkflow } from '../components/workflows/editorState.ts';

// REGRESSIONS for an edit made while a save is in flight:
//  A. A superseded *create* left the editor at `workflowId: null`, so the next
//     Save / ▶ Run POSTed a duplicate workflow definition.
//  B. ▶ Run during a pending Save joined that save and ran the pre-edit steps.

type Req = {
  method: string;
  url: string;
  body: { steps?: WorkflowStep[] };
  resolve: (wf: Workflow) => void;
};

const g = globalThis as unknown as Record<string, unknown>;
let saved: Record<string, unknown>;
let requests: Req[];

function step(prompt: string): WorkflowStep {
  return { id: 's1', title: 'Step 1', prompt, harness: 'claude', kind: 'agent' };
}

function workflow(id: string, prompt: string): Workflow {
  return {
    id,
    name: 'Flow',
    projectPath: 'C:/p',
    steps: [step(prompt)],
    variables: [],
    createdAt: 0,
  };
}

beforeEach(() => {
  requests = [];
  saved = { IS_REACT_ACT_ENVIRONMENT: g.IS_REACT_ACT_ENVIRONMENT, fetch: g.fetch };
  g.IS_REACT_ACT_ENVIRONMENT = true;
  g.fetch = (url: string, init?: { method?: string; body?: string }) => {
    const method = init?.method ?? 'GET';
    if (url.startsWith('/api/workflows') && (method === 'POST' || method === 'PATCH')) {
      return new Promise((resolveFetch) => {
        requests.push({
          method,
          url,
          body: init?.body ? JSON.parse(init.body) : {},
          resolve: (wf) =>
            resolveFetch({ ok: true, status: 200, json: () => Promise.resolve(wf) }),
        });
      });
    }
    return Promise.reject(new Error(`unexpected fetch ${method} ${url}`));
  };
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete g[k];
    else g[k] = v;
  }
});

const tick = () => new Promise((r) => setTimeout(r, 0));

let latest!: ReturnType<typeof useWorkflowEditor>;
const errors: string[] = [];
function Harness({ workflows }: { workflows: Workflow[] }) {
  latest = useWorkflowEditor({
    workflows,
    activeFolder: 'C:/p',
    onError: (msg) => errors.push(msg),
    onStepsAdded: () => {},
  });
  return null;
}

test('REGRESSION: an edit during the first Create leaves the editor on the created workflow', async () => {
  let renderer!: ReturnType<typeof TestRenderer.create>;
  await act(async () => {
    renderer = TestRenderer.create(React.createElement(Harness, { workflows: [] }));
  });
  act(() => latest.newBlank());

  let p!: Promise<Workflow | null>;
  await act(async () => {
    p = latest.save();
    await tick();
  });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, 'POST');

  // Type in the step prompt while the POST is in flight.
  act(() => latest.patchStep(0, { prompt: 'typed mid-create' }));

  await act(async () => {
    requests[0].resolve(workflow('wf9', ''));
    await p;
    await tick();
  });
  // The created workflow has not reached the (WS-fed) list yet; the editor must
  // neither be reset nor lose the edit.
  assert.equal(latest.editor.workflowId, 'wf9', 'points at the created workflow');
  assert.equal(latest.editor.dirty, true, 'the mid-create edit is still unsaved');
  assert.equal(latest.editor.steps[0].prompt, 'typed mid-create');

  // The next save PATCHes it — no second definition.
  await act(async () => {
    latest.save();
    await tick();
  });
  assert.equal(requests.length, 2);
  assert.equal(requests[1].method, 'PATCH');
  assert.match(requests[1].url, /^\/api\/workflows\/wf9\b/);
  assert.equal(requests[1].body.steps?.[0].prompt, 'typed mid-create');
  assert.deepEqual(errors, []);
  act(() => renderer.unmount());
});

test('REGRESSION: Run during a pending Save saves the newer edit before resolving', async () => {
  const wf = workflow('wf1', 'original');
  let renderer!: ReturnType<typeof TestRenderer.create>;
  await act(async () => {
    renderer = TestRenderer.create(React.createElement(Harness, { workflows: [wf] }));
  });
  act(() => latest.setEditor(fromWorkflow(wf)));
  act(() => latest.patchStep(0, { prompt: 'edit 1' }));

  // Save click.
  let saveClick!: Promise<Workflow | null>;
  await act(async () => {
    saveClick = latest.save();
    await tick();
  });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].body.steps?.[0].prompt, 'edit 1');

  // Edit again, then ▶ Run (which saves a dirty editor first).
  act(() => latest.patchStep(0, { prompt: 'edit 2' }));
  let runSave!: Promise<Workflow | null>;
  await act(async () => {
    runSave = latest.save();
    await tick();
  });
  assert.equal(requests.length, 1, 'joins the pending save instead of racing it');

  const echo1 = workflow('wf1', 'edit 1');
  await act(async () => {
    requests[0].resolve(echo1);
    await saveClick;
    await tick();
  });
  assert.equal(requests.length, 2, 'saves again once the pending save settles');
  assert.equal(requests[1].method, 'PATCH');
  assert.equal(requests[1].body.steps?.[0].prompt, 'edit 2');

  const echo2 = workflow('wf1', 'edit 2');
  let result!: Workflow | null;
  await act(async () => {
    requests[1].resolve(echo2);
    result = await runSave;
  });
  assert.equal(result, echo2, 'Run gets the workflow holding what the editor shows');
  assert.equal(requests.length, 2);
  assert.deepEqual(errors, []);
  act(() => renderer.unmount());
});
