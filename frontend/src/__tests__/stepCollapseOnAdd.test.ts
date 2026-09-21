import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { emptyEditor, type EditorState } from '../components/workflows/editorState.ts';
import { useEditorMutationActions } from '../components/workflows/hooks/useEditorMutationActions.ts';
import type { DefaultPrompt } from '../components/workflows/defaultPrompts.ts';

// New workflow steps land collapsed. The collapse map (`useCollapsedSteps`) is
// keyed by step id and lives outside the editor state, so the add actions must
// report the id of the step they created — and it has to be the SAME id that
// ends up committed in `editor.steps`. That's why the id is minted before the
// `setEditor` call rather than inside the updater: an updater can run more than
// once (React StrictMode double-invokes it), so an id generated in there isn't
// necessarily the one that lands in state, and the new step would render
// expanded while a phantom id sat collapsed in userSettings.
//
// This drives the real hook headlessly — it touches nothing but `setEditor`.

let latestActions: ReturnType<typeof useEditorMutationActions> | null = null;
let latestEditor: EditorState | null = null;
let reported: string[] = [];

function Harness() {
  const [editor, setEditor] = React.useState<EditorState>(emptyEditor);
  const onStepsAdded = React.useCallback((ids: string[]) => {
    reported.push(...ids);
  }, []);
  latestActions = useEditorMutationActions(setEditor, onStepsAdded);
  latestEditor = editor;
  return null;
}

const g = globalThis as unknown as Record<string, unknown>;
let savedActEnv: unknown;
let renderer: ReturnType<typeof TestRenderer.create> | null = null;

function mount() {
  act(() => {
    renderer = TestRenderer.create(React.createElement(Harness));
  });
}

beforeEach(() => {
  reported = [];
  latestActions = null;
  latestEditor = null;
  savedActEnv = g.IS_REACT_ACT_ENVIRONMENT;
  g.IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  act(() => {
    renderer?.unmount();
  });
  renderer = null;
  if (savedActEnv === undefined) delete g.IS_REACT_ACT_ENVIRONMENT;
  else g.IS_REACT_ACT_ENVIRONMENT = savedActEnv;
});

const prompt: DefaultPrompt = {
  id: 'refactor',
  label: 'Refactor',
  title: 'Refactor pass',
  prompt: 'Find refactors.',
  icon: (() => null) as unknown as DefaultPrompt['icon'],
};

test('addStep reports the id of the step it committed', () => {
  mount();
  act(() => latestActions!.addStep());

  const steps = latestEditor!.steps;
  assert.equal(steps.length, 1);
  assert.deepEqual(reported, [steps[0].id]);
});

test('every added step is reported once, in order', () => {
  mount();
  act(() => latestActions!.addStep());
  act(() => latestActions!.addDefaultPromptStep(prompt));
  act(() => latestActions!.addStep());

  const ids = latestEditor!.steps.map((s) => s.id);
  assert.equal(new Set(ids).size, 3, 'step ids must be unique');
  assert.deepEqual(reported, ids);
});

test('addDefaultPromptStep reports its id when it bootstraps an empty editor', () => {
  mount();
  // The empty-editor path rebuilds the draft (name from the prompt) rather than
  // appending to the current one — the reported id must still be the committed
  // step's.
  act(() => latestActions!.addDefaultPromptStep(prompt));

  const steps = latestEditor!.steps;
  assert.equal(steps.length, 1);
  assert.equal(latestEditor!.name, prompt.title);
  assert.deepEqual(reported, [steps[0].id]);
});

test('a chip that carries pre-run tools (the "Opengrep" chip) seeds the step with them; other chips leave the field absent', () => {
  mount();
  const opengrep: DefaultPrompt = {
    ...prompt,
    id: 'opengrep',
    label: 'Opengrep',
    title: 'Opengrep Triage',
    tools: ['opengrep'],
  };
  // Both add paths — the empty-editor bootstrap and the append — go through
  // the same step factory, so the tool must survive either way, and a chip
  // without tools must not leave an empty `tools` key behind (the backend
  // normalizer treats absent and empty alike, but the editor's dirty
  // comparison does not).
  act(() => latestActions!.addDefaultPromptStep(opengrep));
  act(() => latestActions!.addDefaultPromptStep(prompt));
  act(() => latestActions!.addDefaultPromptStep(opengrep));

  const steps = latestEditor!.steps;
  assert.equal(steps.length, 3);
  assert.deepEqual(steps[0].tools, ['opengrep']);
  assert.ok(!('tools' in steps[1]), 'a plain chip adds no tools field');
  assert.deepEqual(steps[2].tools, ['opengrep']);
  assert.notEqual(steps[0].tools, opengrep.tools, 'the step owns a copy, not the chip definition');
});

test('control steps are not reported — they have no collapse toggle', () => {
  mount();
  act(() => latestActions!.addControlStep('merge'));

  assert.equal(latestEditor!.steps.length, 1);
  assert.deepEqual(reported, []);
});
