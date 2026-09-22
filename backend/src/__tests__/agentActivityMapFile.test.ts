import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { mapFileToProject } from '../routes/agentActivity.js';
import { canonicalProjectPath } from '../projectPath.js';

// Regression: the in-project check was `rel.startsWith('..')`, which dropped
// every hook for a file whose name (or top-level dir) merely starts with two
// dots — no graph beam for it — while real `../` escapes must still be refused.
test('mapFileToProject keeps `..name` files and still refuses real escapes', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lattice-mapfile-'));
  try {
    const canonical = canonicalProjectPath(root);
    assert.equal(
      mapFileToProject(root, path.join(root, '..eslintrc.js'), null),
      path.join(canonical, '..eslintrc.js'),
    );
    assert.equal(
      mapFileToProject(root, '..cache/a.ts', root),
      path.join(canonical, '..cache', 'a.ts'),
    );
    assert.equal(mapFileToProject(root, path.join(root, '..', 'outside.ts'), null), null);
    assert.equal(mapFileToProject(root, '../outside.ts', root), null);
    assert.equal(mapFileToProject(root, root, null), null);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
