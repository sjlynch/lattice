import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  fmtAge,
  formatTimelineTickLabel,
  formatWorkingTreeLabel,
  nearestHandleForIndex,
  rangeForHandleMove,
  rangeForTrackSelection,
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
