import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import type { WorkflowRun, WorkflowStep } from '../api';
import { collapsibleStepIds, emptyEditor, type EditorState } from '../components/workflows/editorState.ts';
import { useEditorMutationActions } from '../components/workflows/hooks/useEditorMutationActions.ts';
import { postMergeHookConfigured } from '../components/workflows/hooks/usePostMergeHookConfigured.ts';
import { StepRow } from '../components/workflows/StepRow.tsx';
import { parseTimeoutMinutesInput, RUN_TESTS_STEP_HINT } from '../components/workflows/TestStepRow.tsx';
import { runTestsSummaries } from '../components/workflows/WorkflowRunStrip.tsx';

// The workflow "Run tests" step ('test' kind) in the editor: the quick-add
// action seeds it, StepRow routes it to its own row (harness picker + timeout,
// not the harness-less control row), and the run strip lists its summaries.

const g = globalThis as unknown as Record<string, unknown>;
let savedActEnv: unknown;
let renderer: ReturnType<typeof TestRenderer.create> | null = null;

// tsx compiles these .tsx components with the classic JSX transform
// (React.createElement), and the row components import only named hooks.
g.React ??= React;

beforeEach(() => {
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

test('the "Run tests" quick-add seeds a test step (no prompt, default harness + timeout) that has no collapse toggle', () => {
  let actions: ReturnType<typeof useEditorMutationActions> | null = null;
  let editor: EditorState | null = null;
  function Harness() {
    const [state, setState] = React.useState<EditorState>(emptyEditor);
    actions = useEditorMutationActions(setState, () => {});
    editor = state;
    return null;
  }
  act(() => {
    renderer = TestRenderer.create(React.createElement(Harness));
  });
  act(() => actions!.addControlStep('test'));
  const [step] = editor!.steps;
  assert.equal(step.kind, 'test');
  assert.equal(step.title, 'Run tests');
  assert.equal(step.prompt, '');
  assert.equal(step.harness, 'claude');
  assert.equal(step.timeoutMinutes, undefined, 'absent = the 60-minute default');
  assert.deepEqual(collapsibleStepIds(editor!.steps), []);
});

function renderStep(step: WorkflowStep, postMergeHook: boolean) {
  const noop = () => {};
  act(() => {
    renderer = TestRenderer.create(
      React.createElement(StepRow, {
        step,
        index: 0,
        collapsed: true,
        harnessAvail: { claude: true, pi: true, codex: false },
        piMenu: [],
        definedNames: new Set<string>(),
        customizing: false,
        postMergeHookConfigured: postMergeHook,
        onChange: noop,
        onRemove: noop,
        onReorder: noop,
        onToggleCollapse: noop,
        onCustomize: noop,
      }),
    );
  });
  return renderer!;
}

function textOf(node: TestRenderer.ReactTestRenderer): string {
  return JSON.stringify(node.toJSON());
}

test('StepRow renders a test step with a harness picker, a timeout input and the hint', () => {
  const tree = renderStep({ id: 's1', title: 'Run tests', prompt: '', harness: 'pi', kind: 'test', timeoutMinutes: 30 }, false);
  assert.equal(tree.root.findAllByType('select').length, 1, 'harness picker');
  const timeout = tree.root.findByProps({ 'aria-label': 'Timeout in minutes' });
  assert.equal(timeout.props.value, 30);
  assert.ok(textOf(tree).includes('Usually right before Push'));
  assert.ok(!textOf(tree).includes('post-merge hook'));
  assert.ok(RUN_TESTS_STEP_HINT.includes('commits fixes'));
});

test('a test step notes the overlap when the project has a post-merge hook prompt', () => {
  const tree = renderStep({ id: 's1', title: '', prompt: '', harness: 'claude', kind: 'test' }, true);
  assert.ok(textOf(tree).includes('post-merge hook'));
  assert.equal(postMergeHookConfigured({ postMergeHookPrompt: 'Run the test suite and fix issues' }), true);
  assert.equal(postMergeHookConfigured({ postMergeHookPrompt: '   ' }), false);
  assert.equal(postMergeHookConfigured({}), false);
});

test('timeout input: raw while typing, clamped to 5–720 on blur, empty = default', () => {
  assert.equal(parseTimeoutMinutesInput('1'), 1, 'typing "10" must not snap the 1 up to 5');
  assert.equal(parseTimeoutMinutesInput('1', true), 5);
  assert.equal(parseTimeoutMinutesInput('9000', true), 720);
  assert.equal(parseTimeoutMinutesInput('42.6', true), 43);
  assert.equal(parseTimeoutMinutesInput(''), undefined);
  assert.equal(parseTimeoutMinutesInput('abc', true), undefined);
});

test('run strip lists Run tests summaries in step order, ignoring blanks', () => {
  const run = {
    id: 'r', workflowId: 'w', workflowName: 'w', projectPath: '/p', status: 'completed', startedAt: 0,
    totalSteps: 4, currentStepIndex: 4,
    stepSummaries: { 3: 'later', 1: 'first', 2: '  ' },
  } as WorkflowRun;
  assert.deepEqual(runTestsSummaries(run), [
    { stepIndex: 1, text: 'first' },
    { stepIndex: 3, text: 'later' },
  ]);
  assert.deepEqual(runTestsSummaries(null), []);
});
