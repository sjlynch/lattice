import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { buildPostMergeHooksRouter } from '../routes/postMergeHooks.js';
import { postMergeHookDir } from '../postMergeHooks/paths.js';
import { recordPostMergeHook } from '../postMergeHooks/registry.js';
import { sweepOrphanedPostMergeHookSessions } from '../recovery/postMergeHookSweep.js';
import { normalizeCwd } from '../recovery/liveSessions.js';
import type { PostMergeHookRun } from '../postMergeHooks/types.js';

function pmhId(): string {
  return `pmh_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
}

async function mkProject(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'lattice-pmh-cleanup-project-'));
}

async function mkScratch(project: string, id: string): Promise<string> {
  const dir = postMergeHookDir(project, id);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'POST_MERGE_HOOK.md'), '# test\n', 'utf8');
  return dir;
}

function runFor(project: string, id: string): PostMergeHookRun {
  return {
    id,
    projectPath: project,
    harness: 'claude',
    prompt: 'test hook',
    cwd: postMergeHookDir(project, id),
    status: 'running',
    startedAt: Date.now(),
    trigger: 'manual-merge',
  };
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

async function waitForGone(dir: string): Promise<void> {
  const deadline = Date.now() + 6_000;
  while (Date.now() < deadline) {
    if (!(await exists(dir))) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail(`expected ${dir} to be removed`);
}

async function withPostMergeHookServer(
  fn: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const app = express();
  app.use(express.json());
  app.use(buildPostMergeHooksRouter());
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test('POST /api/post-merge-hooks/:id/complete removes pmh scratch', async () => {
  const project = await mkProject();
  const id = pmhId();
  const dir = await mkScratch(project, id);
  recordPostMergeHook(runFor(project, id));

  await withPostMergeHookServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/post-merge-hooks/${id}/complete?source=test`, {
      method: 'POST',
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
  });

  await waitForGone(dir);
});

test('POST /api/post-merge-hooks/:id/abort removes pmh scratch', async () => {
  const project = await mkProject();
  const id = pmhId();
  const dir = await mkScratch(project, id);
  recordPostMergeHook(runFor(project, id));

  await withPostMergeHookServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/post-merge-hooks/${id}/abort`, {
      method: 'POST',
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
  });

  await waitForGone(dir);
});

test('sweepOrphanedPostMergeHookSessions removes orphaned pmh scratch', async () => {
  const project = await mkProject();
  const id = pmhId();
  const dir = await mkScratch(project, id);

  await sweepOrphanedPostMergeHookSessions({
    collectLiveSessionCwds: async () => new Set(),
    forEachKnownProjectSafely: async (_label, fn) => {
      await fn(project);
    },
  });

  assert.equal(await exists(dir), false);
});

test('sweepOrphanedPostMergeHookSessions preserves pmh scratch with a live PTY cwd', async () => {
  const project = await mkProject();
  const id = pmhId();
  const dir = await mkScratch(project, id);

  await sweepOrphanedPostMergeHookSessions({
    collectLiveSessionCwds: async () => new Set([normalizeCwd(dir)]),
    forEachKnownProjectSafely: async (_label, fn) => {
      await fn(project);
    },
  });

  assert.equal(await exists(dir), true);
  await fs.rm(dir, { recursive: true, force: true });
});
