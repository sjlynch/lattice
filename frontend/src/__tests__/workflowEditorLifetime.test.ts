import { afterEach, beforeEach, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import React, { useLayoutEffect, type ReactNode } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import type { Workflow, WorkflowStep, WorkflowVariable } from '../api';
import { TerminalsProvider } from '../TerminalsContext.tsx';
import { ConfirmProvider, useConfirm, type UnsavedChoice } from '../components/shared/ConfirmDialog.tsx';
import { useWorkflowManager } from '../components/workflows/hooks/useWorkflowManager.ts';
import { WorkflowsSavedItem } from '../components/workflows/WorkflowsSavedItem.tsx';
import { emptyEditor } from '../components/workflows/editorState.ts';
import { loadWorkflowDraft, saveWorkflowDraft } from '../components/workflows/workflowDraftStorage.ts';
import type { WorkflowTemplate } from '../workflowTemplates.ts';
import { FakeWebSocket, installGlobal } from './domDoubles.ts';

const A = 'C:/project-A';
const B = 'C:/project-B';
const template: WorkflowTemplate = {
  id: 'template', name: 'Template workflow', description: 'Test template',
  steps: [{ title: 'Template step', prompt: 'Template prompt', kind: 'agent' }],
};
type Request = {
  method: string;
  url: string;
  body: { project?: string; name: string; steps: WorkflowStep[]; variables: WorkflowVariable[] };
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};
let requests: Request[];
let confirmations: Array<(choice: UnsavedChoice) => void>;
let restores: Array<() => void>;
let renderer: ReturnType<typeof TestRenderer.create> | undefined;
let latest!: ReturnType<typeof useWorkflowManager>;
let confirmationApi!: ReturnType<typeof useConfirm>;
let workflows: Workflow[];

function workflow(id: string, projectPath = A): Workflow {
  return {
    id, projectPath, name: id, createdAt: 0,
    steps: [{ id: `step-${id}`, title: 'Step', prompt: 'original', harness: 'claude', kind: 'agent' }],
    variables: [{ name: 'user_instructions', value: '' }],
  };
}
const json = (value: unknown) => ({ ok: true, status: 200, json: async () => value });
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

// Replace only the confirmation service at the provider boundary, keeping the
// actual manager, editor, saved-list actions, persistence, and API calls wired.
const confirmUnsaved = () => new Promise<UnsavedChoice>((resolve) => confirmations.push(resolve));
function ConfirmStub({ children }: { children: ReactNode }) {
  const api = useConfirm();
  useLayoutEffect(() => { confirmationApi = api; });
  return children;
}
function Harness({ folder }: { folder: string }) {
  const manager = useWorkflowManager(folder, null);
  useLayoutEffect(() => { latest = manager; });
  const wf = manager.sortedWorkflows[0];
  return wf ? React.createElement(WorkflowsSavedItem, {
    workflow: wf, isSelected: manager.editor.workflowId === wf.id,
    starting: false, queuedCount: 0, harnessOverride: null, harnessOptions: [],
    onSelect: manager.actions.selectWorkflow,
    onSetHarnessOverride: manager.actions.setWorkflowHarnessOverride,
    onEnqueue: manager.actions.enqueueWorkflow,
    onRun: manager.actions.runWorkflow,
    onStopRun: manager.actions.stopRun,
  }) : null;
}
function tree(folder: string) {
  return React.createElement(ConfirmProvider, {
    children: React.createElement(ConfirmStub, {
      children: React.createElement(TerminalsProvider, {
        activeFolder: '', restoreMode: null,
        children: React.createElement(Harness, { folder }),
      }),
    }),
  });
}
async function mount(folder = A) {
  await act(async () => { renderer = TestRenderer.create(tree(folder)); await flush(); });
  mock.method(confirmationApi, 'confirmUnsaved', confirmUnsaved);
  await act(async () => { renderer!.update(tree(folder)); await flush(); });
}
async function switchProject(folder: string) {
  await act(async () => { renderer!.update(tree(folder)); await flush(); });
}
async function newDraft(name = 'Draft A') {
  await act(async () => { await latest.actions.newBlank(); });
  act(() => {
    latest.actions.updateEditorName(name);
    latest.actions.patchStep(0, { prompt: `prompt for ${name}` });
    latest.actions.patchVariable(0, { value: `variables for ${name}` });
  });
}
function choose(choice: UnsavedChoice) {
  assert.ok(confirmations.length, 'the manager requested confirmation');
  confirmations.shift()!(choice);
}
function echo(index: number, id: string): Workflow {
  const request = requests[index];
  return {
    ...workflow(id, request.body.project ?? A),
    name: request.body.name,
    steps: request.body.steps,
    variables: request.body.variables,
  };
}
async function startSave() {
  let pending!: Promise<Workflow | null>;
  await act(async () => { pending = latest.actions.save(); await flush(); });
  return { pending };
}

beforeEach(() => {
  requests = [];
  confirmations = [];
  workflows = [workflow('saved-A'), workflow('other-A'), workflow('saved-B', B)];
  FakeWebSocket.instances = [];
  const storage = new Map<string, string>();
  const storageApi = {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => { storage.set(key, value); },
    removeItem: (key: string) => { storage.delete(key); },
  };
  restores = [
    installGlobal('IS_REACT_ACT_ENVIRONMENT', true),
    installGlobal('React', React),
    installGlobal('WebSocket', FakeWebSocket),
    installGlobal('window', {
      location: { protocol: 'http:', host: 'localhost:5184' },
      addEventListener() {}, removeEventListener() {},
      setTimeout, clearTimeout,
    }),
    installGlobal('document', { addEventListener() {}, removeEventListener() {} }),
    installGlobal('localStorage', storageApi),
    installGlobal('sessionStorage', storageApi),
    installGlobal('fetch', (url: string, init?: { method?: string; body?: string }) => {
      const method = init?.method ?? 'GET';
      if (url.startsWith('/api/workflows') && ['POST', 'PATCH', 'DELETE'].includes(method)) {
        return new Promise((resolve, reject) => {
          requests.push({
            method, url, body: JSON.parse(init?.body ?? '{}'),
            resolve: (value) => resolve(json(value)), reject,
          });
        });
      }
      if (url.startsWith('/api/workflows?')) {
        const folder = new URL(url, 'http://localhost').searchParams.get('project');
        return Promise.resolve(json(workflows.filter((wf) => wf.projectPath === folder)));
      }
      if (url.startsWith('/api/workflow-runs/active?')) return Promise.resolve(json([]));
      if (url.startsWith('/api/settings?')) return Promise.resolve(json({}));
      if (url === '/api/pi-models') return Promise.resolve(json({ menu: [], models: [] }));
      throw new Error(`unexpected fetch ${method} ${url}`);
    }),
  ];
});
afterEach(() => {
  if (renderer) act(() => renderer!.unmount());
  renderer = undefined;
  mock.restoreAll();
  for (const restore of restores.reverse()) restore();
});

test('selected saved-row clicks and manager reselect preserve every unsaved field', async () => {
  await mount();
  const wf = workflows[0];
  await act(async () => { await latest.actions.selectWorkflow(wf); });
  act(() => {
    latest.actions.updateEditorName('Edited name');
    latest.actions.patchStep(0, { prompt: 'Edited prompt' });
    latest.actions.patchVariable(0, { value: 'Edited variable' });
  });
  const edited = latest.editor;
  act(() => {
    renderer!.root.findAllByType('div').find((node) =>
      node.props.className === 'workflows-item active')!.props.onClick();
  });
  await act(async () => { await latest.actions.selectWorkflow(wf); });
  assert.equal(latest.editor, edited);
  assert.equal(latest.editor.dirty, true);
  assert.equal(confirmations.length, 0);
  assert.equal(requests.length, 0);
});

test('template action Cancel and failed Save keep the draft and never create the template', async () => {
  await mount();
  await newDraft();
  const draft = latest.editor;
  let cancelled!: Promise<void>;
  act(() => { cancelled = latest.actions.newFromTemplate(template); });
  assert.equal(requests.length, 0);
  await act(async () => { choose('cancel'); await cancelled; });
  assert.equal(latest.editor, draft);
  assert.equal(requests.length, 0);

  let pending!: Promise<void>;
  await act(async () => {
    pending = latest.actions.newFromTemplate(template);
    choose('save');
    await flush();
  });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].body.name, 'Draft A', 'only the existing draft is saved');
  await act(async () => { requests[0].reject(new Error('save unavailable')); await pending; });
  assert.equal(latest.editor, draft);
  assert.equal(requests.length, 1, 'failed Save never starts the template POST');
});

for (const choice of ['save', 'discard'] as const) {
  test(`template replacement proceeds after ${choice}`, async () => {
    await mount();
    await newDraft();
    let pending!: Promise<void>;
    await act(async () => {
      pending = latest.actions.newFromTemplate(template);
      choose(choice);
      await flush();
    });
    if (choice === 'save') {
      assert.equal(requests[0].body.name, 'Draft A');
      await act(async () => { requests[0].resolve(echo(0, 'created-A')); await flush(); });
    }
    const index = choice === 'save' ? 1 : 0;
    assert.equal(requests.length, index + 1);
    assert.equal(requests[index].body.name, template.name);
    await act(async () => { requests[index].resolve(echo(index, 'created-template')); await pending; });
    assert.equal(latest.editor.workflowId, 'created-template');
    assert.equal(latest.editor.dirty, false);
  });
}

test('delayed Create and its joiner cannot adopt an id or PATCH a discarded replacement draft', async () => {
  await mount();
  await newDraft();
  const { pending: first } = await startSave();
  act(() => latest.actions.patchStep(0, { prompt: 'edit while saving A' }));
  const { pending: joiner } = await startSave();
  await act(async () => {
    const replacing = latest.actions.newBlank();
    choose('discard');
    await replacing;
  });
  act(() => latest.actions.updateEditorName('Draft B'));
  const draftB = latest.editor;
  saveWorkflowDraft(A, draftB);
  assert.equal(latest.savingEditor, false);
  await act(async () => {
    requests[0].resolve(echo(0, 'created-A'));
    assert.deepEqual(await Promise.all([first, joiner]), [null, null]);
  });
  assert.equal(latest.editor, draftB);
  assert.equal(latest.editor.workflowId, null);
  assert.equal(loadWorkflowDraft(A)?.name, 'Draft B', 'late create must not clear B stash');
  assert.equal(requests.length, 1, 'old joiner never saves draft B');

  const { pending: second } = await startSave();
  assert.equal(requests[1].method, 'POST');
  assert.equal(requests[1].body.name, 'Draft B');
  await act(async () => { requests[1].resolve(echo(1, 'created-B')); await second; });
  assert.equal(latest.editor.workflowId, 'created-B');
});

test('project B can Save its restored draft while project A and its joiner remain pending', async () => {
  await mount();
  await newDraft();
  const { pending: first } = await startSave();
  const { pending: joiner } = await startSave();
  saveWorkflowDraft(B, { ...emptyEditor(), name: 'B restored', dirty: true });
  await switchProject(B);
  assert.equal(latest.editor.name, 'B restored');
  assert.equal(latest.editor.workflowId, null);
  assert.equal(latest.savingEditor, false);
  const { pending: second } = await startSave();
  assert.equal(requests.length, 2, 'B save does not join A');
  assert.equal(requests[1].body.project, B);

  await act(async () => {
    requests[0].resolve(echo(0, 'created-A'));
    assert.deepEqual(await Promise.all([first, joiner]), [null, null]);
  });
  assert.equal(latest.editor.name, 'B restored');
  assert.equal(latest.editor.workflowId, null);
  assert.equal(latest.savingEditor, true, 'old finally cannot release B save');
  assert.equal(loadWorkflowDraft(B)?.name, 'B restored');
  assert.equal(requests.length, 2, 'no chained cross-project PATCH');
  await act(async () => { requests[1].resolve(echo(1, 'created-B')); await second; });
  assert.equal(latest.editor.workflowId, 'created-B');
});

for (const mutation of ['create', 'update'] as const) {
  test(`late ${mutation} is ignored after project A -> B -> A`, async () => {
    await mount();
    if (mutation === 'create') await newDraft();
    else {
      await act(async () => { await latest.actions.selectWorkflow(workflows[0]); });
      act(() => latest.actions.updateEditorName('unsaved A update'));
    }
    const { pending } = await startSave();
    await switchProject(B);
    await switchProject(A);
    const returned = latest.editor;
    await act(async () => { requests[0].resolve(echo(0, 'saved-A')); assert.equal(await pending, null); });
    assert.equal(latest.editor, returned);
    assert.equal(latest.editor.workflowId, null);
    if (mutation === 'create') assert.equal(loadWorkflowDraft(A)?.name, 'Draft A');
  });
}

for (const outcome of ['success', 'failure'] as const) {
  for (const replacement of ['blank', 'project'] as const) {
    test(`late template ${outcome} preserves the replacement ${replacement}`, async () => {
      await mount();
      let pending!: Promise<void>;
      await act(async () => { pending = latest.actions.newFromTemplate(template); await flush(); });
      assert.equal(requests.length, 1);
      if (replacement === 'project') {
        saveWorkflowDraft(B, { ...emptyEditor(), name: 'B restored', dirty: true });
        await switchProject(B);
      } else {
        await act(async () => {
          const replacing = latest.actions.newBlank();
          choose('discard');
          await replacing;
        });
        act(() => latest.actions.updateEditorName('Replacement'));
      }
      const replacementDraft = latest.editor;
      await act(async () => {
        if (outcome === 'success') requests[0].resolve(echo(0, 'template-A'));
        else requests[0].reject(new Error('template failed'));
        await pending;
      });
      assert.equal(latest.editor, replacementDraft);
      assert.equal(latest.editor.workflowId, null);
      assert.equal(latest.error, null);
    });
  }
}

for (const outcome of ['success', 'failure'] as const) {
  test(`late delete ${outcome} cannot clear or toast over another selected workflow`, async () => {
    await mount();
    await act(async () => { await latest.actions.selectWorkflow(workflows[0]); });
    let pending!: Promise<void>;
    await act(async () => { pending = latest.actions.deleteCurrent(); });
    await act(async () => { await latest.actions.selectWorkflow(workflows[1]); });
    const selected = latest.editor;
    await act(async () => {
      if (outcome === 'success') requests[0].resolve({ ok: true });
      else requests[0].reject(new Error('delete failed'));
      await pending;
    });
    assert.equal(latest.editor, selected);
    assert.equal(latest.error, null);
  });
}

for (const choice of ['save', 'discard'] as const) {
  test(`stale ${choice} confirmation cannot mutate or replace a project restored after A -> B -> A`, async () => {
    await mount();
    await newDraft();
    let pending!: Promise<void>;
    act(() => { pending = latest.actions.newFromTemplate(template); });
    await switchProject(B);
    await switchProject(A);
    const returned = latest.editor;
    await act(async () => { choose(choice); await pending; });
    assert.equal(latest.editor, returned);
    assert.equal(requests.length, 0, 'no stale Save or template POST');
  });
}

test('a switch awaiting Save cannot continue after a newer editor replacement', async () => {
  await mount();
  await newDraft();
  let pending!: Promise<void>;
  await act(async () => {
    pending = latest.actions.newFromTemplate(template);
    choose('save');
    await flush();
  });
  await act(async () => {
    const replacing = latest.actions.newBlank();
    choose('discard');
    await replacing;
  });
  act(() => latest.actions.updateEditorName('Newer draft'));
  const replacement = latest.editor;
  await act(async () => { requests[0].resolve(echo(0, 'created-A')); await pending; });
  assert.equal(latest.editor, replacement);
  assert.equal(requests.length, 1);
});

test('same-draft create joiners save newer edits once using the created id', async () => {
  await mount();
  await newDraft();
  const { pending: first } = await startSave();
  act(() => latest.actions.patchStep(0, { prompt: 'Typed during create' }));
  const { pending: joiner1 } = await startSave();
  const { pending: joiner2 } = await startSave();
  assert.equal(requests.length, 1);
  await act(async () => {
    requests[0].resolve(echo(0, 'created-A'));
    await first;
    await flush();
  });
  assert.equal(requests.length, 2, 'joiners share one follow-up save');
  assert.equal(requests[1].method, 'PATCH');
  assert.match(requests[1].url, /\/created-A\?/);
  assert.equal(requests[1].body.steps[0].prompt, 'Typed during create');
  const saved = echo(1, 'created-A');
  await act(async () => {
    requests[1].resolve(saved);
    assert.deepEqual(await Promise.all([joiner1, joiner2]), [saved, saved]);
  });
  assert.equal(latest.editor.workflowId, 'created-A');
  assert.equal(latest.editor.dirty, false);
});

test('edits typed during the confirmation Save are preserved instead of replaced', async () => {
  await mount();
  await newDraft();
  let pending!: Promise<void>;
  await act(async () => {
    pending = latest.actions.newFromTemplate(template);
    choose('save');
    await flush();
  });
  act(() => latest.actions.patchStep(0, { prompt: 'New unsaved edit' }));
  await act(async () => { requests[0].resolve(echo(0, 'created-A')); await pending; });
  assert.equal(latest.editor.workflowId, 'created-A');
  assert.equal(latest.editor.steps[0].prompt, 'New unsaved edit');
  assert.equal(latest.editor.dirty, true);
  assert.equal(requests.length, 1, 'the template must not replace newer unsaved content');
});

test('a current template failure keeps its editable draft and a retry creates it once', async () => {
  await mount();
  let pending!: Promise<void>;
  await act(async () => { pending = latest.actions.newFromTemplate(template); await flush(); });
  act(() => latest.actions.patchStep(0, { prompt: 'Template edit' }));
  await act(async () => { requests[0].reject(new Error('offline')); await pending; });
  assert.equal(latest.editor.name, template.name);
  assert.equal(latest.editor.steps[0].prompt, 'Template edit');
  assert.equal(latest.editor.workflowId, null);
  assert.equal(latest.editor.dirty, true);
  assert.match(latest.error!, /Could not create from template: offline/);
  const { pending: retry } = await startSave();
  assert.equal(requests[1].method, 'POST');
  await act(async () => { requests[1].resolve(echo(1, 'retry-template')); await retry; });
  assert.equal(latest.editor.workflowId, 'retry-template');
});
