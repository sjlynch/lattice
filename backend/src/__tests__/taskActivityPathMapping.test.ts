import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mapWorktreeFileToProject } from '../routes/tasks/activity.js';
import { canonicalProjectPath } from '../projectPath.js';

// `rel.startsWith('..')` rejected escapes but ALSO a legit in-worktree file or
// directory whose name merely begins with two dots (`..foo`), so the graph
// never beamed to it.
test('mapWorktreeFileToProject keeps `..`-prefixed names, still rejects escapes', () => {
  const base = path.join(os.tmpdir(), 'lattice-activity-map');
  const task = { worktreePath: path.join(base, 'wt'), projectPath: path.join(base, 'repo') };
  const root = canonicalProjectPath(task.projectPath);

  assert.equal(mapWorktreeFileToProject(task, '..foo/bar.ts'), path.join(root, '..foo', 'bar.ts'));
  assert.equal(
    mapWorktreeFileToProject(task, path.join(task.worktreePath, '..hidden.ts')),
    path.join(root, '..hidden.ts'),
  );
  assert.equal(mapWorktreeFileToProject(task, 'src/a.ts'), path.join(root, 'src', 'a.ts'));

  assert.equal(mapWorktreeFileToProject(task, '../escape.ts'), null);
  assert.equal(mapWorktreeFileToProject(task, '..'), null);
  assert.equal(mapWorktreeFileToProject(task, path.join(base, 'elsewhere.ts')), null);
  assert.equal(mapWorktreeFileToProject(task, task.worktreePath), null);
  assert.equal(mapWorktreeFileToProject(task, 'LATTICE_TASK.md'), null, 'managed files still dropped');
});
