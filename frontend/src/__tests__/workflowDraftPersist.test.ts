import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { EditorState } from '../components/workflows/editorState.ts';
import {
  draftForFolder,
  reconcileDraftPersist,
} from '../components/workflows/workflowDraftPersist.ts';
import { loadWorkflowDraft } from '../components/workflows/workflowDraftStorage.ts';
import { USER_INSTRUCTIONS_VAR } from '../components/workflows/promptVariables.ts';
import { installGlobal } from './domDoubles.ts';

const A = 'C:/proj-a';
const B = 'C:/proj-b';

// A never-saved draft with content (the only kind that persists).
function draft(name: string): EditorState {
  return {
    identity: Symbol(),
    workflowId: null,
    name,
    steps: [
      {
        id: 's1',
        title: 'Step 1',
        prompt: 'do the thing',
        harness: 'claude',
        kind: 'agent',
      },
    ],
    variables: [],
    dirty: true,
  };
}

const EMPTY: EditorState = {
  identity: Symbol(),
  workflowId: null,
  name: '',
  steps: [],
  variables: [],
  dirty: false,
};

// Replay the persist effect over a sequence of (folder, editor) commits, exactly
// as the hook's refs would thread the decision from one render to the next.
// Returns the writes the effect actually performed (debounced + flushed alike).
function replayPersist(
  commits: Array<{ folder: string; editor: EditorState }>,
): Array<{ folder: string; editor: EditorState; kind: 'persist' | 'flush' }> {
  const writes: Array<{
    folder: string;
    editor: EditorState;
    kind: 'persist' | 'flush';
  }> = [];
  let lastFolder: string | null = null;
  let lastEditor: EditorState | null = null;
  for (const { folder, editor } of commits) {
    const { decision, nextFolder, nextEditor } = reconcileDraftPersist(
      folder,
      editor,
      lastFolder,
      lastEditor,
    );
    lastFolder = nextFolder;
    lastEditor = nextEditor;
    if (decision.kind !== 'idle') {
      writes.push({ folder: decision.folder, editor, kind: decision.kind });
    }
  }
  return writes;
}

test('REGRESSION: a draft authored under A is never persisted under B on a project switch', () => {
  const dA = draft('A draft'); // authored in project A
  const dB = draft('B draft'); // B's own stored draft, loaded by the restore effect

  // 1. mount on A (empty), 2. user types → dA, 3. switch to B carrying the SAME
  // dA object (launcher doesn't remount), 4. restore effect swaps in B's draft.
  const writes = replayPersist([
    { folder: A, editor: EMPTY },
    { folder: A, editor: dA },
    { folder: B, editor: dA }, // danger render: A's draft object under folder B
    { folder: B, editor: dB },
  ]);

  // A's draft must never have been written under B's key.
  assert.ok(
    !writes.some((w) => w.folder === B && w.editor === dA),
    'A’s draft must not be persisted under project B',
  );
  // It is instead flushed back under A (so a fast switch doesn't lose it).
  assert.ok(
    writes.some((w) => w.folder === A && w.editor === dA && w.kind === 'flush'),
    'A’s carried-over draft should be flushed under project A',
  );
  // B ends up persisting its own draft under its own key.
  assert.ok(
    writes.some((w) => w.folder === B && w.editor === dB && w.kind === 'persist'),
    'B’s own draft should persist under project B',
  );
});

test('genuine edits under a stable folder persist normally', () => {
  const d1 = draft('one');
  const d2 = draft('one two'); // a real edit → a brand-new editor object
  const writes = replayPersist([
    { folder: A, editor: EMPTY },
    { folder: A, editor: d1 },
    { folder: A, editor: d2 },
  ]);
  assert.deepEqual(
    writes.map((w) => ({ folder: w.folder, kind: w.kind })),
    [
      { folder: A, kind: 'persist' },
      { folder: A, kind: 'persist' },
    ],
  );
});

test('leaving the project entirely still flushes the outgoing draft', () => {
  const outgoing = draft('outgoing');
  const result = reconcileDraftPersist('', outgoing, A, outgoing);
  assert.deepEqual(result.decision, { kind: 'flush', folder: A });
});

test('an empty / saved editor is never persisted', () => {
  const saved: EditorState = { ...draft('saved'), workflowId: 'wf1' };
  const r1 = reconcileDraftPersist(A, EMPTY, null, null);
  const r2 = reconcileDraftPersist(A, saved, null, null);
  assert.equal(r1.decision.kind, 'idle');
  assert.equal(r2.decision.kind, 'idle');
});

test('draftForFolder swaps a carried-over draft for the new project’s stored draft', () => {
  const carried = draft('A draft'); // still in the editor after the switch
  const stored = draft('B draft'); // B's own draft from localStorage
  // B has its own draft → adopt it, dropping A's carried-over draft.
  assert.equal(draftForFolder(carried, stored), stored);
  // B has no draft → clear to empty rather than keep A's draft.
  const cleared = draftForFolder(carried, null);
  assert.equal(cleared.workflowId, null);
  assert.equal(cleared.steps.length, 0);
  assert.equal(cleared.name, '');
});

// REGRESSION: a draft stashed before workflows had variables restores with
// `variables: undefined`; `WorkflowEditorPanel` maps over `editor.variables`
// unconditionally, so the restore threw and wedged the panel. The loader now
// normalizes a missing/invalid list to the editor's shape (built-in included).
test('loadWorkflowDraft normalizes a pre-variables draft to a valid variables list', () => {
  const stored: Record<string, string> = {};
  const restore = installGlobal('localStorage', {
    getItem: (k: string) => stored[k] ?? null,
    setItem: (k: string, v: string) => { stored[k] = v; },
    removeItem: (k: string) => { delete stored[k]; },
  });
  try {
    const legacy = { ...draft('old draft') } as Partial<EditorState>;
    delete legacy.variables;
    stored[`lattice.workflowEditorDraft.${A}`] = JSON.stringify(legacy);
    const restored = loadWorkflowDraft(A);
    assert.ok(restored, 'the draft still restores');
    assert.ok(Array.isArray(restored.variables));
    assert.deepEqual(
      restored.variables.map((v) => v.name),
      [USER_INSTRUCTIONS_VAR],
    );
    assert.equal(restored.dirty, true);

    // A non-array `variables` is treated the same way.
    stored[`lattice.workflowEditorDraft.${A}`] = JSON.stringify({ ...legacy, variables: 'nope' });
    assert.deepEqual(
      loadWorkflowDraft(A)?.variables.map((v) => v.name),
      [USER_INSTRUCTIONS_VAR],
    );

    // A draft that already has custom variables keeps them (built-in prepended).
    stored[`lattice.workflowEditorDraft.${A}`] = JSON.stringify({
      ...legacy,
      variables: [{ name: 'scope', value: 'backend' }],
    });
    assert.deepEqual(
      loadWorkflowDraft(A)?.variables.map((v) => v.name),
      [USER_INSTRUCTIONS_VAR, 'scope'],
    );
  } finally {
    restore();
  }
});

test('draftForFolder clears a loaded (saved) workflow on project switch', () => {
  const saved: EditorState = { ...draft('saved'), workflowId: 'wf1' };
  const stored = draft('B draft');
  assert.equal(draftForFolder(saved, stored), stored);

  const cleared = draftForFolder(saved, null);
  assert.equal(cleared.workflowId, null);
  assert.equal(cleared.steps.length, 0);
  assert.equal(cleared.name, '');
});
