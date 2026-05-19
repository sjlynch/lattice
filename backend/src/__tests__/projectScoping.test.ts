import { test } from 'node:test';
import assert from 'node:assert/strict';
import { partitionByProject } from '../routes/tasks/crudHandlers.js';
import { canonicalProjectPath } from '../projectPath.js';
import type { Task } from '../tasks.js';

// The defence-in-depth filter inside /api/tasks. The on-disk task store
// at one project's hash dir has been observed to hold tasks tagged for a
// different project (the 2026-05-19 ody/rewrite vs react-chorus incident).
// `partitionByProject` is what makes that invisible to API consumers:
// foreign tasks land in `foreign`, never in `safe`. These tests guard
// against regressions in that filtering — especially around
// canonicalization (case/separator differences must NOT count as foreign).

const ODY = 'C:\\development\\ody\\rewrite';
const RC = 'C:\\development\\react-chorus';

function task(id: string, projectPath: string): Task {
  return {
    id,
    projectPath,
    title: id,
    status: 'open',
    createdAt: 0,
  };
}

test('partitionByProject: all foreign tasks are filtered out', () => {
  const all = [task('a', RC), task('b', RC)];
  const { safe, foreign } = partitionByProject(all, canonicalProjectPath(ODY));
  assert.equal(safe.length, 0);
  assert.equal(foreign.length, 2);
  assert.deepEqual(foreign.map((t) => t.id), ['a', 'b']);
});

test('partitionByProject: mixed list separates matching from foreign', () => {
  const all = [task('a', RC), task('b', ODY), task('c', RC), task('d', ODY)];
  const { safe, foreign } = partitionByProject(all, canonicalProjectPath(ODY));
  assert.deepEqual(safe.map((t) => t.id), ['b', 'd']);
  assert.deepEqual(foreign.map((t) => t.id), ['a', 'c']);
});

test('partitionByProject: empty input yields empty partitions', () => {
  const { safe, foreign } = partitionByProject([], canonicalProjectPath(ODY));
  assert.equal(safe.length, 0);
  assert.equal(foreign.length, 0);
});

test('partitionByProject: case-different drive letters do not count as foreign', () => {
  // Windows path canonicalization uppercases the drive letter. A task
  // whose stored projectPath happens to be lowercase must still match a
  // query for the same project — otherwise the canonical-mismatch filter
  // would scrub legitimate tasks.
  const lowered = 'c:\\development\\ody\\rewrite';
  const { safe, foreign } = partitionByProject(
    [task('a', lowered)],
    canonicalProjectPath(ODY),
  );
  assert.equal(safe.length, 1);
  assert.equal(foreign.length, 0);
});
