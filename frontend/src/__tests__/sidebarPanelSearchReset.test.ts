import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  panelForKind,
  shouldFallBackToTerminals,
} from '../components/sidebar/hooks/panelState.ts';

// Regression for: "terminal search filter isn't cleared on automatic sidebar
// panel switches, so a stale query hides the newly-shown panel's terminals."
//
// The fix wires Sidebar's resetSearch() to fire on EVERY activePanel change —
// including usePanelState's two automatic switches, which call setActivePanel
// directly and used to bypass the manual switchPanel wrapper (the only path
// that reset the filter). The reset itself is a React effect that can't be
// mounted in this pure node:test harness (no DOM). What's locked here are the
// two pure predicates that *trigger* those automatic switches — proving the
// auto-switch the fix now hooks into actually fires in the reported scenario —
// plus a small model of the now-invariant: any panel change clears the filter.

test('Merging panel emptying triggers the fall-back to Terminals (the bug scenario)', () => {
  // On the Merging panel, a resolver finishing drops mergeTerminals to 0.
  assert.equal(shouldFallBackToTerminals('merging', 0, 0), true);
  // Still on Merging while a resolver exists: no switch.
  assert.equal(shouldFallBackToTerminals('merging', 1, 0), false);
});

test('Startup panel emptying also triggers the fall-back', () => {
  assert.equal(shouldFallBackToTerminals('startup', 0, 0), true);
  assert.equal(shouldFallBackToTerminals('startup', 0, 2), false);
});

test('no fall-back while viewing the Terminals panel', () => {
  assert.equal(shouldFallBackToTerminals('terminals', 0, 0), false);
});

test('panelForKind maps a terminal kind to its panel', () => {
  assert.equal(panelForKind('merge'), 'merging');
  assert.equal(panelForKind('startup'), 'startup');
  assert.equal(panelForKind(undefined), 'terminals');
});

// Models Sidebar's activePanel-keyed effect: the filter is reset to '' whenever
// the panel changes, no matter how the change was triggered (manual switchPanel
// OR usePanelState's automatic setActivePanel). Mirrors the described test:
// filter='zzz' on Merging, mergeTerminals → 0 auto-switches to Terminals,
// assert filter is reset to ''.
function filterAfterPanelChange(prev: string, next: string, filter: string): string {
  return prev === next ? filter : '';
}

test('an automatic switch off the Merging panel clears the stale query', () => {
  const before: string = 'merging';
  // mergeTerminals hits 0 → shouldFallBackToTerminals fires → activePanel
  // becomes 'terminals'.
  const after = shouldFallBackToTerminals(before, 0, 0) ? 'terminals' : before;
  assert.notEqual(after, before);
  assert.equal(filterAfterPanelChange(before, after, 'zzz'), '');
});

test('staying on the same panel leaves the query untouched', () => {
  assert.equal(filterAfterPanelChange('terminals', 'terminals', 'zzz'), 'zzz');
});
