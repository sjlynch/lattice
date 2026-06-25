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
    mode: 'sequential',
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
