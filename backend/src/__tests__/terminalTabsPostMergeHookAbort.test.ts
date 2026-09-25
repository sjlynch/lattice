import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import type { PostMergeHookRun } from '../postMergeHooks/types.js';

// Regression: a post-merge hook's sidebar tab is a registered terminal-tab
// record, so its × close goes through DELETE /api/terminal-tabs/:id. Only
// DELETE /api/terminals/:id used to end the hook `aborted`; the tabs route
// ended the record and killed the pty but left the hook `running` with nothing
// watching its pty, so the merge run / workflow Merge step sat in
// `waitForPostMergeHook` for POST_MERGE_HOOK_MAX_WAIT_MS (30 min) holding the
// project run.lock — every manual /merge, Merge All and Merge step got a 409.
// Both close routes now share `abortPostMergeHookForServerId`, run before the
// kill.
//
// A fake terminal-server answers the pty kill (and records the hook's status at
// that moment, proving the abort lands first). TERMINAL_PORT is pointed at it
// BEFORE the routes are imported, because BASE is captured from that env var at
// module load (and `node --test` runs each file in its own process).

type Kill = { serverId: string; hookStatusAtKill: string | undefined };

let fakeTerminalServer: http.Server | null = null;
const kills: Kill[] = [];
let watchedHookId: string | null = null;

let registry: typeof import('../postMergeHooks/registry.js');
let terminalRegistry: (typeof import('../terminalRegistry/store.js'))['terminalRegistry'];
let buildTerminalTabsRouter: (typeof import('../routes/terminalTabs.js'))['buildTerminalTabsRouter'];
let buildTerminalsRouter: (typeof import('../routes/terminals.js'))['buildTerminalsRouter'];

before(async () => {
  fakeTerminalServer = http.createServer((req, res) => {
    const m = /^\/sessions\/([^/?]+)$/.exec(req.url ?? '');
    if (req.method === 'DELETE' && m) {
      kills.push({
        serverId: decodeURIComponent(m[1]!),
        hookStatusAtKill: watchedHookId ? registry.getPostMergeHook(watchedHookId)?.status : undefined,
      });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => fakeTerminalServer!.listen(0, '127.0.0.1', resolve));
  process.env.TERMINAL_PORT = String((fakeTerminalServer.address() as AddressInfo).port);

  registry = await import('../postMergeHooks/registry.js');
  ({ terminalRegistry } = await import('../terminalRegistry/store.js'));
  ({ buildTerminalTabsRouter } = await import('../routes/terminalTabs.js'));
  ({ buildTerminalsRouter } = await import('../routes/terminals.js'));
});

after(async () => {
  await new Promise<void>((resolve) => (fakeTerminalServer ? fakeTerminalServer.close(() => resolve()) : resolve()));
});

async function withApp(fn: (baseUrl: string) => Promise<void>): Promise<void> {
  const app = express();
  app.use(express.json());
  app.use(buildTerminalsRouter());
  app.use(buildTerminalTabsRouter());
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function setup(): Promise<{ project: string; hookId: string; serverId: string; tabId: string }> {
  const project = await fs.mkdtemp(path.join(os.tmpdir(), 'lattice-pmh-tabclose-'));
  const hookId = `pmh_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
  const serverId = `tty_pmh_tabclose_${crypto.randomBytes(4).toString('hex')}`;
  const run: PostMergeHookRun = {
    id: hookId,
    projectPath: project,
    harness: 'claude',
    prompt: 'test hook',
    cwd: path.join(os.tmpdir(), hookId),
    status: 'running',
    startedAt: Date.now(),
    trigger: 'merge-run',
    serverId,
  };
  registry.recordPostMergeHook(run);
  const record = await terminalRegistry.create({
    projectPath: project,
    cwd: run.cwd,
    label: 'post-merge hook',
    owner: 'post-merge',
    launch: { initialCommand: 'claude', harness: 'claude' },
    serverId,
  });
  watchedHookId = hookId;
  return { project, hookId, serverId, tabId: record.id };
}

test('DELETE /api/terminal-tabs/:id on a running post-merge hook tab aborts the hook and releases its waiters', async () => {
  const { project, hookId, serverId, tabId } = await setup();
  kills.length = 0;
  // Stands in for the merge run parked in runPostMergeHookGate.
  const waiting = registry.waitForPostMergeHook(hookId);
  try {
    await withApp(async (baseUrl) => {
      const res = await fetch(
        `${baseUrl}/api/terminal-tabs/${encodeURIComponent(tabId)}?project=${encodeURIComponent(project)}`,
        { method: 'DELETE' },
      );
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { ok: true });
    });

    const hook = registry.getPostMergeHook(hookId);
    assert.equal(hook?.status, 'aborted');
    assert.equal(hook?.error, 'terminal closed by user');
    assert.equal(registry.getActiveHookForServerId(serverId), null);
    assert.equal(registry.getActiveHookForProject(project), null, 'the project gate is free again');
    const outcome = await Promise.race([
      waiting,
      new Promise<'still-parked'>((resolve) => setTimeout(() => resolve('still-parked'), 1_000).unref()),
    ]);
    assert.equal(outcome, 'finished', 'the merge-run waiter is released immediately');

    // The pty is still killed — once, after the hook was already aborted.
    assert.deepEqual(kills, [{ serverId, hookStatusAtKill: 'aborted' }]);
    assert.equal((await terminalRegistry.list(project)).some((r) => r.id === tabId), false);
  } finally {
    registry.finishPostMergeHook(hookId, 'aborted', 'test cleanup');
    watchedHookId = null;
  }
});

test('DELETE /api/terminals/:id still aborts the owning post-merge hook through the shared helper', async () => {
  const { project, hookId, serverId, tabId } = await setup();
  kills.length = 0;
  const waiting = registry.waitForPostMergeHook(hookId);
  try {
    await withApp(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/terminals/${encodeURIComponent(serverId)}`, { method: 'DELETE' });
      assert.equal(res.status, 200);
    });

    assert.equal(registry.getPostMergeHook(hookId)?.status, 'aborted');
    assert.equal(await waiting, 'finished');
    assert.deepEqual(kills, [{ serverId, hookStatusAtKill: 'aborted' }]);
    assert.equal((await terminalRegistry.list(project)).some((r) => r.id === tabId), false);
  } finally {
    registry.finishPostMergeHook(hookId, 'aborted', 'test cleanup');
    watchedHookId = null;
  }
});

test('DELETE /api/terminal-tabs/:id on an ordinary tab leaves an unrelated running hook alone', async () => {
  const { project, hookId } = await setup();
  const other = await terminalRegistry.create({
    projectPath: project,
    cwd: project,
    label: 'claude 1',
    owner: 'user',
    launch: { initialCommand: 'claude', harness: 'claude' },
    serverId: `tty_user_${crypto.randomBytes(4).toString('hex')}`,
  });
  try {
    await withApp(async (baseUrl) => {
      const res = await fetch(
        `${baseUrl}/api/terminal-tabs/${encodeURIComponent(other.id)}?project=${encodeURIComponent(project)}`,
        { method: 'DELETE' },
      );
      assert.equal(res.status, 200);
    });
    assert.equal(registry.getPostMergeHook(hookId)?.status, 'running');
  } finally {
    registry.finishPostMergeHook(hookId, 'aborted', 'test cleanup');
    watchedHookId = null;
  }
});
