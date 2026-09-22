import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { canonicalProjectPath } from '../projectPath.js';
import {
  finishPostMergeHook,
  getActiveHookForProject,
  getActiveHookForServerId,
  getPostMergeHook,
  patchPostMergeHook,
  recordPostMergeHook,
  waitForPostMergeHook,
} from '../postMergeHooks/registry.js';
import type { PostMergeHookRun } from '../postMergeHooks/types.js';

function makeRun(id: string, projectPath: string): PostMergeHookRun {
  return {
    id,
    projectPath,
    harness: 'claude',
    prompt: 'test',
    cwd: path.join(os.tmpdir(), id),
    status: 'running',
    startedAt: Date.now(),
    trigger: 'manual-merge',
  };
}

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

// Nothing observes the hook's pty, so a hook agent that dies without calling
// back used to park every waiter (the merge run, and through it a workflow
// Merge step) forever. The deadline finishes it `errored` and unblocks them.
test('waitForPostMergeHook finishes errored after maxWaitMs when no callback arrives', async () => {
  const project = path.join(os.tmpdir(), `lattice-pmh-wait-${process.pid}`);
  const id = `pmh_wait_expire_${Date.now()}`;
  recordPostMergeHook(makeRun(id, project));
  try {
    const other = waitForPostMergeHook(id);
    const result = await waitForPostMergeHook(id, 20);
    assert.equal(result, 'expired');
    assert.equal(await other, 'finished', 'the other waiters are released too');
    const run = getPostMergeHook(id);
    assert.equal(run?.status, 'errored');
    assert.match(run?.error ?? '', /did not call back within/);
    assert.equal(getActiveHookForProject(project), null);
  } finally {
    finishPostMergeHook(id, 'aborted', 'test cleanup');
  }
});

test('waitForPostMergeHook resolves finished when the callback beats the deadline', async () => {
  const project = path.join(os.tmpdir(), `lattice-pmh-wait-${process.pid}`);
  const id = `pmh_wait_callback_${Date.now()}`;
  recordPostMergeHook(makeRun(id, project));
  const waiting = waitForPostMergeHook(id, 60_000);
  finishPostMergeHook(id, 'completed');
  assert.equal(await waiting, 'finished');
  assert.equal(getPostMergeHook(id)?.status, 'completed');
  assert.equal(getPostMergeHook(id)?.error, undefined);
});

test('getActiveHookForServerId finds a running hook by its pty and nothing once it finished', () => {
  const project = path.join(os.tmpdir(), `lattice-pmh-server-${process.pid}`);
  const id = `pmh_by_server_${Date.now()}`;
  recordPostMergeHook(makeRun(id, project));
  try {
    assert.equal(getActiveHookForServerId('server_pmh_1'), null);
    patchPostMergeHook(id, { serverId: 'server_pmh_1' });
    assert.equal(getActiveHookForServerId('server_pmh_1')?.id, id);
    finishPostMergeHook(id, 'completed');
    assert.equal(getActiveHookForServerId('server_pmh_1'), null);
  } finally {
    finishPostMergeHook(id, 'aborted', 'test cleanup');
  }
});
