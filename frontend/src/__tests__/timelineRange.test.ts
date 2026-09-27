import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  fmtAge,
  formatTimelineTickLabel,
  formatTimelineTickTooltip,
  formatWorkingTreeLabel,
  nearestHandleForIndex,
  rangeForHandleMove,
  rangeForTrackSelection,
  reconcileTimelineRange,
  tickIndexFromClientX,
  tickPositionsForCount,
} from '../components/forceGraph/timelineRange.ts';

const minute = 60_000;
const hour = 60 * minute;
const day = 24 * hour;

test('fmtAge formats minute, hour, and day buckets', () => {
  const now = 1_000_000_000;
  assert.equal(fmtAge(now - 30_000, now), 'just now');
  assert.equal(fmtAge(now - 12 * minute, now), '12m ago');
  assert.equal(fmtAge(now - 3 * hour, now), '3h ago');
  assert.equal(fmtAge(now - 2 * day, now), '2d ago');
});

test('tickPositionsForCount spreads ticks and centers a single tick', () => {
  assert.deepEqual(tickPositionsForCount(1), [50]);
  assert.deepEqual(tickPositionsForCount(5), [0, 25, 50, 75, 100]);
});

test('tickIndexFromClientX rounds to the nearest tick and clamps to the track', () => {
  const bounds = { left: 100, width: 200 };
  assert.equal(tickIndexFromClientX(100, bounds, 5), 0);
  assert.equal(tickIndexFromClientX(151, bounds, 5), 1);
  assert.equal(tickIndexFromClientX(500, bounds, 5), 4);
  assert.equal(tickIndexFromClientX(50, bounds, 5), 0);
});

test('formatTimelineTickLabel keeps working-tree labels separate from commits', () => {
  const now = 10 * day;
  const commits = [{ shortSha: 'abc1234', subject: 'Split scrubber', date: now - hour }];
  assert.equal(formatTimelineTickLabel(0, commits, false, now), 'abc1234 · Split scrubber · 1h ago');
  assert.equal(formatTimelineTickLabel(1, commits, false, now), 'Working tree (clean)');
  assert.equal(formatWorkingTreeLabel(true), 'Working tree (uncommitted)');
});

test('formatTimelineTickTooltip shows the full commit message', () => {
  const now = 10 * day;
  const commits = [
    { shortSha: 'abc1234', subject: 'Split scrubber', body: 'Why:\n- reasons', authorName: 'Ann', date: now - hour },
    { shortSha: 'def5678', subject: 'No body', date: now - minute * 5 },
  ];
  assert.equal(
    formatTimelineTickTooltip(0, commits, false, now),
    'abc1234 · Ann · 1h ago\n\nSplit scrubber\n\nWhy:\n- reasons',
  );
  assert.equal(formatTimelineTickTooltip(1, commits, false, now), 'def5678 · 5m ago\n\nNo body');
  assert.equal(formatTimelineTickTooltip(2, commits, true, now), 'Working tree (uncommitted)');
});

test('rangeForHandleMove carries the opposite handle when crossing', () => {
  assert.deepEqual(rangeForHandleMove('left', 2, 1, 4), { left: 2, right: 4 });
  assert.deepEqual(rangeForHandleMove('left', 5, 1, 4), { left: 5, right: 5 });
  assert.deepEqual(rangeForHandleMove('right', 3, 1, 4), { left: 1, right: 3 });
  assert.deepEqual(rangeForHandleMove('right', 0, 1, 4), { left: 0, right: 0 });
});

test('nearestHandleForIndex chooses the left handle on ties', () => {
  assert.equal(nearestHandleForIndex(3, 2, 4), 'left');
  assert.equal(nearestHandleForIndex(4, 2, 4), 'right');
});

test('rangeForTrackSelection applies nearest-handle and carry behavior', () => {
  assert.deepEqual(rangeForTrackSelection(1, 3, 3), {
    handle: 'left',
    range: { left: 1, right: 3 },
  });
  assert.deepEqual(rangeForTrackSelection(5, 3, 3), {
    handle: 'left',
    range: { left: 5, right: 5 },
  });
});

// Regression: when a background git-status refresh reloads history (a commit
// made/undone while the tab is open), the working-tree tick shifts index and
// the scrubber range must follow so the live update never yanks the user off
// the working tree — the core of the "still shows uncommitted after commit" fix.
test('reconcileTimelineRange keeps the default full range spanning the new working tree', () => {
  // 5 commits (WT tick = 5). A new commit while capped at fewer than the limit
  // pushes the WT tick to 6; the untouched full range must still cover it so
  // the (now clean) working tree stays selected and re-rings.
  assert.deepEqual(reconcileTimelineRange({ left: 0, right: 5 }, 5, 6), {
    left: 0,
    right: 6,
  });
  // Empty repo's first commit: WT tick 0 → 1, full range grows to include the
  // new commit rather than collapsing onto the working tree.
  assert.deepEqual(reconcileTimelineRange({ left: 0, right: 0 }, 0, 1), {
    left: 0,
    right: 1,
  });
  // History window capped (10 commits): a new commit drops the oldest, so the
  // tick count is unchanged and the full range is untouched.
  assert.deepEqual(reconcileTimelineRange({ left: 0, right: 10 }, 10, 10), {
    left: 0,
    right: 10,
  });
});

test('reconcileTimelineRange keeps a right handle parked on the working tree pinned to it', () => {
  // Left scrubbed into history, right on the WT slot: the right handle follows
  // the working tree to its new index; the left index is preserved.
  assert.deepEqual(reconcileTimelineRange({ left: 3, right: 8 }, 8, 9), {
    left: 3,
    right: 9,
  });
});

test('reconcileTimelineRange preserves and clamps a range parked inside history', () => {
  // Both handles inspecting historical commits (not on the WT): indices are
  // preserved when they still fit...
  assert.deepEqual(reconcileTimelineRange({ left: 2, right: 5 }, 8, 9), {
    left: 2,
    right: 5,
  });
  // ...and clamped into [0, newWt] when a commit was undone (WT tick shrank),
  // never leaving a handle past the end of the new tick space.
  assert.deepEqual(reconcileTimelineRange({ left: 6, right: 7 }, 8, 4), {
    left: 4,
    right: 4,
  });
});
