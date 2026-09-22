import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bulkCloseTargets } from '../components/sidebar/hooks/tabBulkClose.ts';

const ids = ['a', 'b', 'c', 'd'];

test('bulkCloseTargets: left / right / others relative to the tab', () => {
  assert.deepEqual(bulkCloseTargets(ids, 'c', 'left'), ['a', 'b']);
  assert.deepEqual(bulkCloseTargets(ids, 'b', 'right'), ['c', 'd']);
  assert.deepEqual(bulkCloseTargets(ids, 'b', 'others'), ['a', 'c', 'd']);
  assert.deepEqual(bulkCloseTargets(ids, 'a', 'left'), []);
});

// Regression: the context menu can outlive its tab (the pty exited and the
// tab was removed, or a search filter hid it). `findIndex` → -1 made "close to
// the right" target EVERY tab and "close to the left" all but the last.
test('bulkCloseTargets closes nothing when the tab is no longer visible', () => {
  assert.equal(bulkCloseTargets(ids, 'gone', 'right'), null);
  assert.equal(bulkCloseTargets(ids, 'gone', 'left'), null);
  assert.equal(bulkCloseTargets(ids, 'gone', 'others'), null);
});
