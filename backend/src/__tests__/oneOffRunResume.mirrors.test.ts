// The push / QA / post-merge-hook registries lived only in memory while their
// agents' ptys live in the detached terminal-server, so a backend restart
// orphaned every running session (the full story: oneOffRunResume.boot.test.ts).
// Running records are now mirrored to
// ~/.lattice/per-project/<hash>/{push-runs,qa-runs,post-merge-hooks}.json.
// These pin the three mirrors: a running record (with its workflow owner, its
// QA verdict) is persisted and dropped once done, and untrusted push records
// are re-validated on load (id guard, status, cwd re-derived from the scratch
// path guard). Shared fixtures: helpers/oneOffRunResume.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { canonicalProjectPath } from '../projectPath.js';
import { forgetPushRun, markPushRunDone, pushRunStore, recordPushRun } from '../pushRuns.js';
import { deserializePushRun } from '../pushRuns/registry.js';
import { pushPaths } from '../pushRuns/paths.js';
import { forgetQaRun, markQaRunDone, qaRunStore, recordQaRun, recordQaVerdict } from '../qaRuns.js';
import { qaPaths } from '../qaRuns/paths.js';
import { finishPostMergeHook, postMergeHookStore } from '../postMergeHooks.js';
import { recordPostMergeHook } from '../postMergeHooks/registry.js';
import { postMergeHookPaths } from '../postMergeHooks/paths.js';
import { exists, mkProject } from './helpers/oneOffRunResume.js';

test('push-run mirror: a running run is persisted with its workflow owner and dropped once done', async () => {
  const project = await mkProject();
  const id = pushPaths.createSessionId();
  try {
    recordPushRun({
      id,
      projectPath: project,
      cwd: pushPaths.sessionDir(project, id),
      status: 'running',
      createdAt: 5,
      serverId: 'srv-1',
      workflowRunId: 'wfrun_mirror',
      workflowStepIndex: 2,
    });
    await pushRunStore.flush(project);
    const loaded = await pushRunStore.load(project);
    assert.equal(loaded.length, 1);
    assert.equal(loaded[0].id, id);
    assert.equal(loaded[0].serverId, 'srv-1');
    assert.equal(loaded[0].workflowRunId, 'wfrun_mirror');
    assert.equal(loaded[0].workflowStepIndex, 2);

    markPushRunDone(id);
    await pushRunStore.flush(project);
    assert.deepEqual(await pushRunStore.load(project), []);
    assert.equal(await exists(pushRunStore.file(project)), false, 'nothing running ⇒ no file');
  } finally {
    forgetPushRun(id);
    await fs.rm(project, { recursive: true, force: true });
  }
});

test('push-run mirror: untrusted records are re-validated (id guard, status, cwd re-derived)', () => {
  // A sibling of the isolated home (os.tmpdir() itself CONTAINS it, which the
  // path guard rightly refuses as "scratch inside the project").
  const project = canonicalProjectPath(path.join(os.tmpdir(), 'lattice-oneoff-deserialize'));
  const id = pushPaths.createSessionId();
  assert.equal(deserializePushRun({ id: '../../etc', status: 'running' }, project), null);
  assert.equal(deserializePushRun({ id, status: 'done' }, project), null);
  const run = deserializePushRun(
    { id, status: 'running', cwd: 'C:/somewhere/else', workflowRunId: 'wf', workflowStepIndex: -1 },
    project,
  );
  assert.ok(run);
  // The on-disk cwd is ignored: recovery matches the live pty by it and the
  // cleanup deletes it, so it always comes from the scratch path guard.
  assert.equal(run.cwd, pushPaths.assertSafeSessionPath(project, id));
  assert.equal(run.workflowRunId, undefined, 'an invalid owner step is dropped');
});

test('QA-run mirror keeps the recorded verdict until the run is done', async () => {
  const project = await mkProject();
  const id = qaPaths.createSessionId();
  try {
    recordQaRun({
      id,
      taskId: 'task-1',
      projectPath: project,
      cwd: qaPaths.sessionDir(project, id),
      status: 'running',
      createdAt: 1,
    });
    recordQaVerdict(id, { passed: true, confident: true, receivedAt: 7 });
    await qaRunStore.flush(project);
    const [loaded] = await qaRunStore.load(project);
    assert.deepEqual(loaded.verdict, { passed: true, confident: true, receivedAt: 7 });
    assert.equal(loaded.taskId, 'task-1');

    markQaRunDone(id);
    await qaRunStore.flush(project);
    assert.deepEqual(await qaRunStore.load(project), []);
  } finally {
    forgetQaRun(id);
    await fs.rm(project, { recursive: true, force: true });
  }
});

test('post-merge-hook mirror: running hook persisted, dropped when it finishes', async () => {
  const project = await mkProject();
  const id = postMergeHookPaths.createSessionId();
  try {
    recordPostMergeHook({
      id,
      projectPath: project,
      harness: 'claude',
      prompt: 'update the docs',
      cwd: postMergeHookPaths.sessionDir(project, id),
      status: 'running',
      startedAt: 3,
      trigger: 'merge-run',
    });
    await postMergeHookStore.flush(project);
    const [loaded] = await postMergeHookStore.load(project);
    assert.equal(loaded.id, id);
    assert.equal(loaded.prompt, 'update the docs');

    finishPostMergeHook(id, 'completed');
    await postMergeHookStore.flush(project);
    assert.deepEqual(await postMergeHookStore.load(project), []);
  } finally {
    await fs.rm(project, { recursive: true, force: true });
  }
});
