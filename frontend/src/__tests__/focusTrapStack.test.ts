import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isTopFocusTrap, pushFocusTrap, removeFocusTrap } from '../hooks/useFocusTrap.ts';

// Regression: a confirm Modal opened over a FloatingPanel (sibling portals)
// left BOTH focus traps handling Tab, each pulling focus back into its own
// container, so the modal's middle buttons were unreachable by keyboard. Only
// the innermost (most recently opened) trap may act.
test('only the most recently opened focus trap handles Tab', () => {
  const panel = Symbol('panel');
  const modal = Symbol('modal');
  pushFocusTrap(panel);
  assert.equal(isTopFocusTrap(panel), true);

  pushFocusTrap(modal);
  assert.equal(isTopFocusTrap(modal), true);
  assert.equal(isTopFocusTrap(panel), false);

  removeFocusTrap(modal);
  assert.equal(isTopFocusTrap(panel), true);

  // Closing out of order (the panel first) leaves the other trap in charge.
  pushFocusTrap(modal);
  removeFocusTrap(panel);
  assert.equal(isTopFocusTrap(modal), true);
  removeFocusTrap(modal);
  assert.equal(isTopFocusTrap(modal), false);
});
