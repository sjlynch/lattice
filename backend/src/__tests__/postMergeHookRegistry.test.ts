import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { canonicalProjectPath } from '../projectPath.js';
import {
  finishPostMergeHook,
  getActiveHookForProject,
  recordPostMergeHook,
} from '../postMergeHooks/registry.js';
import type { PostMergeHookRun } from '../postMergeHooks/types.js';

test('post-merge registry canonicalizes the stored project path', () => {
  const canonical = canonicalProjectPath(
    path.join(os.tmpdir(), `lattice-pmh-registry-${process.pid}`),
  );
  const nonCanonical = path.join(canonical, '..', path.basename(canonical));
  const id = `pmh_registry_${Date.now()}`;
  const run: PostMergeHookRun = {
    id,
    projectPath: nonCanonical,
    harness: 'claude',
    prompt: 'test',
    cwd: path.join(os.tmpdir(), id),
    status: 'running',
    startedAt: Date.now(),
    trigger: 'manual-merge',
  };

  try {
    recordPostMergeHook(run);
    const active = getActiveHookForProject(canonical);
    assert.equal(active?.id, id);
    assert.equal(active?.projectPath, canonical);
  } finally {
    finishPostMergeHook(id, 'aborted', 'test cleanup');
  }
});
