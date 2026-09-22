import { test } from 'node:test';
import assert from 'node:assert/strict';
import { guardUnsavedSwitch } from '../components/workflows/unsavedSwitch.ts';
import type { UnsavedChoice } from '../components/shared/ConfirmDialog.tsx';

// Regression: `selectWorkflow` / `newBlank` used to replace the editor
// unconditionally, silently discarding unsaved edits — only the panel-close
// path asked first. Both now run through `guardUnsavedSwitch`, which mirrors
// that close flow: Save → proceed on success, Discard → drop edits then
// proceed, Cancel → leave the editor untouched.

function deps(choice: UnsavedChoice, dirty = true, saveOk = true) {
  const calls: string[] = [];
  return {
    calls,
    deps: {
      dirty,
      confirmUnsaved: async () => {
        calls.push('confirm');
        return choice;
      },
      save: async () => {
        calls.push('save');
        return saveOk ? { id: 'wf1' } : null;
      },
      discardEdits: () => {
        calls.push('discard');
      },
    },
  };
}

test('a clean editor proceeds without asking', async () => {
  const { calls, deps: d } = deps('cancel', false);
  assert.equal(await guardUnsavedSwitch(d), true);
  assert.deepEqual(calls, []);
});

test('cancel keeps the editor: nothing saved, nothing discarded, no switch', async () => {
  const { calls, deps: d } = deps('cancel');
  assert.equal(await guardUnsavedSwitch(d), false);
  assert.deepEqual(calls, ['confirm']);
});

test('save then switch', async () => {
  const { calls, deps: d } = deps('save');
  assert.equal(await guardUnsavedSwitch(d), true);
  assert.deepEqual(calls, ['confirm', 'save']);
});

test('a failed save blocks the switch so the edits are not lost', async () => {
  const { calls, deps: d } = deps('save', true, false);
  assert.equal(await guardUnsavedSwitch(d), false);
  assert.deepEqual(calls, ['confirm', 'save']);
});

test('discard drops the edits then switches', async () => {
  const { calls, deps: d } = deps('discard');
  assert.equal(await guardUnsavedSwitch(d), true);
  assert.deepEqual(calls, ['confirm', 'discard']);
});
