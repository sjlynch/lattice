import { test } from 'node:test';
import assert from 'node:assert/strict';
import { enterBelongsToFocusedControl } from '../components/shared/ConfirmDialog.tsx';

// Regression: the confirm dialog's window-level "Enter = primary action" handler
// preventDefault-ed Enter on EVERY target, so Tab to Cancel + Enter ran the
// destructive Delete (and Discard + Enter ran Save). A focused button must keep
// its native Enter activation.

const within = (match: boolean) => ({ closest: () => (match ? {} : null) });

test('Enter on a focused button (Cancel/Discard) is left to the button', () => {
  assert.equal(enterBelongsToFocusedControl(within(true) as unknown as EventTarget), true);
});

test('Enter elsewhere in the dialog still triggers the primary action', () => {
  assert.equal(enterBelongsToFocusedControl(within(false) as unknown as EventTarget), false);
  assert.equal(enterBelongsToFocusedControl(null), false);
  assert.equal(enterBelongsToFocusedControl({} as EventTarget), false);
});
