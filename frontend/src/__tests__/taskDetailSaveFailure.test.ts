import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import type { Task } from '../api';
import { TaskDetailOverlay } from '../components/taskboard/TaskDetailOverlay.tsx';
import { ConfirmProvider } from '../components/shared/ConfirmDialog.tsx';

// Regression: a failed task-detail save must keep the overlay open with the
// user's edits intact. Before the fix, TaskDetailOverlay called onSave(updates)
// without awaiting and then ALWAYS closed, while the edit action swallowed PATCH
// failures into a toast — so a backend rejection dismissed the modal as if the
// edit had landed, silently discarding the user's text. Now onSave resolves a
// boolean (the edit action returns false on failure) and the overlay closes
// only on success.
//
// This drives the real component headlessly. TaskDetailOverlay reaches for
// `document`/`window` (Escape handler + useFocusTrap) and renders inside a
// <ConfirmProvider>; react-test-renderer leaves host refs null so the focus
// trap's effect no-ops. We stub just enough of the browser globals.

const g = globalThis as unknown as Record<string, unknown>;
let saved: Record<string, unknown>;

beforeEach(() => {
  saved = {
    IS_REACT_ACT_ENVIRONMENT: g.IS_REACT_ACT_ENVIRONMENT,
    React: g.React,
    window: g.window,
    document: g.document,
  };
  g.IS_REACT_ACT_ENVIRONMENT = true;
  // `tsx` compiles the app's .tsx with the classic JSX runtime (they emit
  // React.createElement without importing React), so expose it globally.
  g.React = React;
  g.window = { addEventListener() {}, removeEventListener() {} };
  g.document = {
    activeElement: null,
    addEventListener() {},
    removeEventListener() {},
    contains: () => false,
  };
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete g[k];
    else g[k] = v;
  }
});

function makeTask(): Task {
  return {
    id: 't1',
    projectPath: 'C:/proj',
    title: 'Original title',
    description: 'Original description',
    status: 'open',
    createdAt: 0,
  };
}

type Rendered = {
  renderer: ReturnType<typeof TestRenderer.create>;
  titleValue: () => string;
  descValue: () => string;
  saveDisabled: () => boolean;
  type: (placeholder: 'Title' | 'Description', value: string) => void;
  clickSave: () => Promise<void>;
};

function render(
  task: Task,
  onSave: (u: { title?: string; description?: string }) => Promise<boolean>,
  onClose: () => void,
): Rendered {
  let renderer!: ReturnType<typeof TestRenderer.create>;
  act(() => {
    renderer = TestRenderer.create(
      React.createElement(
        ConfirmProvider,
        null,
        React.createElement(TaskDetailOverlay, {
          task,
          onClose,
          onMove: () => {},
          onDelete: () => {},
          onSave,
        }),
      ),
    );
  });
  const input = (placeholder: string) =>
    renderer.root.find(
      (n) =>
        (n.type === 'input' || n.type === 'textarea') &&
        n.props.placeholder === placeholder,
    );
  const saveButton = () =>
    renderer.root.find(
      (n) => n.type === 'button' && n.props.className === 'btn-primary',
    );
  return {
    renderer,
    titleValue: () => input('Title').props.value,
    descValue: () => input('Description').props.value,
    saveDisabled: () => !!saveButton().props.disabled,
    type: (placeholder, value) => {
      act(() => {
        input(placeholder).props.onChange({ target: { value } });
      });
    },
    clickSave: async () => {
      await act(async () => {
        saveButton().props.onClick();
        // Flush the async save chain: setSaving(true) → await onSave →
        // close-or-setSaving(false).
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });
    },
  };
}

test('a rejected save keeps the overlay open and preserves the edited fields', async () => {
  let closeCount = 0;
  const onClose = () => {
    closeCount++;
  };
  // The edit action returns false on a PATCH failure (it toasts the error).
  const onSave = () => Promise.resolve(false);

  const ui = render(makeTask(), onSave, onClose);

  assert.equal(ui.saveDisabled(), true, 'Save is disabled until a field is dirty');
  ui.type('Title', 'My edited title');
  ui.type('Description', 'My edited description');
  assert.equal(ui.saveDisabled(), false, 'Save enables once dirty');

  await ui.clickSave();

  assert.equal(closeCount, 0, 'a failed save must NOT close the overlay');
  assert.equal(
    ui.titleValue(),
    'My edited title',
    'the in-progress title edit is preserved on failure',
  );
  assert.equal(
    ui.descValue(),
    'My edited description',
    'the in-progress description edit is preserved on failure',
  );
  assert.equal(
    ui.saveDisabled(),
    false,
    'Save re-enables after the failure so the user can retry',
  );

  act(() => ui.renderer.unmount());
});

test('a save that throws (rejected promise) also keeps the overlay open', async () => {
  let closeCount = 0;
  const onSave = () => Promise.reject(new Error('network down'));

  const ui = render(makeTask(), onSave, () => {
    closeCount++;
  });
  ui.type('Title', 'Edited despite the network');
  await ui.clickSave();

  assert.equal(closeCount, 0, 'a thrown save must not close the overlay either');
  assert.equal(ui.titleValue(), 'Edited despite the network');

  act(() => ui.renderer.unmount());
});

test('a successful save closes the overlay', async () => {
  let closeCount = 0;
  const onSave = () => Promise.resolve(true);

  const ui = render(makeTask(), onSave, () => {
    closeCount++;
  });
  ui.type('Title', 'Edited and saved');
  await ui.clickSave();

  assert.equal(closeCount, 1, 'a successful save closes the overlay exactly once');

  act(() => ui.renderer.unmount());
});
