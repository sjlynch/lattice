import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyUpsertTarget,
  partitionByProject,
} from '../routes/tasks/crudHandlers.js';
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

// ---------- classifyUpsertTarget ----------
//
// The project-scoping guard for POST /api/tasks/upsert?project=X. `updateTask`
// resolves an id across EVERY known project, so before the guard an upsert
// against B containing a {id=...} that actually belongs to A would mutate A's
// task — pasting a round-trip markdown doc from one project into another's
// upsert endpoint silently corrupted the wrong project. The guard fetches the
// existing task and compares canonical project paths, treating a foreign id as
// 'foreign' (reported, never updated) so /upsert only ever touches its own
// project's tasks.

test("classifyUpsertTarget: another project's task id is foreign, never updated", () => {
  // Upsert is scoped to project B (react-chorus); the pasted doc carried
  // project A's (ody/rewrite) task id. It must NOT be updated — A stays
  // untouched and the id is reported as foreign.
  const aTask = task('t_from_A', ODY);
  assert.equal(classifyUpsertTarget(aTask, canonicalProjectPath(RC)), 'foreign');
});

test('classifyUpsertTarget: an unknown id anywhere is missing', () => {
  assert.equal(classifyUpsertTarget(null, canonicalProjectPath(RC)), 'missing');
  assert.equal(classifyUpsertTarget(undefined, canonicalProjectPath(RC)), 'missing');
});

test('classifyUpsertTarget: an id in the same project is updatable', () => {
  const bTask = task('t_in_B', RC);
  assert.equal(classifyUpsertTarget(bTask, canonicalProjectPath(RC)), 'update');
});

test('classifyUpsertTarget: same project via case-different drive still updates', () => {
  // Canonicalization must run on both sides so a lowercase-drive stored path
  // isn't misread as foreign (which would wrongly skip a legitimate update).
  const lowered = task('t_in_B', 'c:\\development\\react-chorus');
  assert.equal(classifyUpsertTarget(lowered, canonicalProjectPath(RC)), 'update');
});
