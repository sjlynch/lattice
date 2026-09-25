import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Workflow, WorkflowStep } from '../api';
import {
  fromWorkflow,
  nextEditorAfterSave,
  type EditorState,
} from '../components/workflows/editorState.ts';

function step(over: Partial<WorkflowStep> = {}): WorkflowStep {
  return {
    id: 's1',
    title: 'Step 1',
    prompt: 'do the thing\n\n{{user_instructions}}',
    harness: 'claude',
    kind: 'agent',
    ...over,
  };
}

function workflow(over: Partial<Workflow> = {}): Workflow {
  return {
    id: 'wf1',
    name: 'My workflow',
    projectPath: 'C:/proj',
    steps: [step()],
    variables: [],
    createdAt: 0,
    ...over,
  };
}

// The editor a user is editing when they click Save: a saved workflow loaded
// into the editor (dirty becomes true the moment they type).
function editorFor(w: Workflow, over: Partial<EditorState> = {}): EditorState {
  return { ...fromWorkflow(w), dirty: true, ...over };
}

test('no mid-save edit → adopt the server echo and clear dirty', () => {
  const w = workflow();
  const atSaveStart = editorFor(w);
  // The save resolves with the server's echo; the committed state is still the
  // exact object we started with (the user typed nothing during the request).
  const { editor, superseded } = nextEditorAfterSave(atSaveStart, atSaveStart, w);
  assert.equal(superseded, false);
  assert.equal(editor.dirty, false);
  assert.equal(editor.workflowId, w.id);
});

test('REGRESSION: an edit made during the in-flight save survives and stays dirty', () => {
  const w = workflow();
  const atSaveStart = editorFor(w);

  // The user retitles a step while the POST is in flight. Every edit produces a
  // brand-new editor object (patchStep spreads), so `current` !== `atSaveStart`.
  const current: EditorState = {
    ...atSaveStart,
    steps: atSaveStart.steps.map((s, i) =>
      i === 0 ? { ...s, title: 'Edited mid-save' } : s,
    ),
    dirty: true,
  };

  // The POST resolves with the PRE-edit server echo (it never saw the edit).
  const { editor, superseded } = nextEditorAfterSave(atSaveStart, current, w);

  assert.equal(superseded, true);
  // The edit must NOT be overwritten by the stale echo...
  assert.equal(editor.steps[0].title, 'Edited mid-save');
  // ...and the editor must stay dirty so the change can be re-saved.
  assert.equal(editor.dirty, true);
  // The kept state is exactly the user's in-flight edit, untouched.
  assert.equal(editor, current);
});

test('a fresh server echo replaces an unedited editor by value', () => {
  const before = workflow({ name: 'Old name' });
  const atSaveStart = editorFor(before);
  // Server persisted a renamed workflow; with no concurrent edit we adopt it.
  const saved = workflow({ name: 'New name' });
  const { editor } = nextEditorAfterSave(atSaveStart, atSaveStart, saved);
  assert.equal(editor.name, 'New name');
  assert.equal(editor.dirty, false);
});

test('a mid-save NAME edit supersedes (the mid-save edit is kept)', () => {
  const w = workflow();
  const atSaveStart = editorFor(w);
  // Renaming the workflow mid-flight also produces a fresh editor object.
  const current: EditorState = { ...atSaveStart, name: 'Renamed mid-save', dirty: true };
  const { superseded } = nextEditorAfterSave(atSaveStart, current, w);
  assert.equal(superseded, true);
});

test('a mid-save VARIABLE edit supersedes (the mid-save edit is kept)', () => {
  const w = workflow();
  const atSaveStart = editorFor(w);
  const current: EditorState = {
    ...atSaveStart,
    variables: [{ name: 'custom_var', value: 'added mid-save' }],
    dirty: true,
  };
  const { superseded } = nextEditorAfterSave(atSaveStart, current, w);
  assert.equal(superseded, true);
});

// REGRESSION: a create (POST) superseded by a mid-save edit used to keep
// `current` verbatim — `workflowId: null` — although the server had already
// created the workflow. The editor still read as an unsaved draft labelled
// "Create", so the next Save / ▶ Run POSTed a duplicate definition (and the
// stash restored after a reload made a third).
test('REGRESSION: a superseded create adopts the created id and stays dirty', () => {
  const atSaveStart = editorFor(workflow(), { workflowId: null });
  const edited: EditorState = {
    ...atSaveStart,
    steps: atSaveStart.steps.map((s, i) =>
      i === 0 ? { ...s, prompt: 'typed during the create POST' } : s,
    ),
    dirty: true,
  };
  const { editor, superseded } = nextEditorAfterSave(atSaveStart, edited, workflow({ id: 'wf9' }));
  assert.equal(superseded, true);
  // Points at the created workflow, so the next save is a PATCH…
  assert.equal(editor.workflowId, 'wf9');
  // …and still carries (and flags) the unsaved mid-save edit.
  assert.equal(editor.dirty, true);
  assert.equal(editor.steps[0].prompt, 'typed during the create POST');
});

test('a clean create adopts the server echo', () => {
  const atSaveStart = editorFor(workflow(), { workflowId: null });
  const { editor, superseded } = nextEditorAfterSave(atSaveStart, atSaveStart, workflow({ id: 'wf9' }));
  assert.equal(superseded, false);
  assert.equal(editor.workflowId, 'wf9');
  assert.equal(editor.dirty, false);
});
