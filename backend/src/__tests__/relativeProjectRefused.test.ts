import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { WebSocket } from 'ws';
import { readProjectParam, relativeProjectError } from '../routes/projectParam.js';
import { parseProject } from '../ws/projectEndpoint.js';
import { buildTasksWss } from '../ws/endpoints/tasks.js';
import { canonicalProjectPath, isRealAbsoluteProjectPath, msysToWindowsPath } from '../projectPath.js';

// Every per-project store resolves its path through canonicalProjectPath ==
// path.resolve, so a RELATIVE `project` used to land under the backend's own
// cwd: `PATCH /api/settings?project=foo` created
// `<backend>/foo/.lattice/userSettings.json`, and the workflow / terminal-tab
// / merge-run / instrumentation routes did the same for their stores. The
// task routes have refused this for a while; `readProjectParam` extends the
// rule to every other project-scoped route.

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
}

async function close(server: http.Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

function fakeRes() {
  const sent = { status: null as number | null, body: null as unknown };
  const res = {
    status(n: number) { sent.status = n; return res; },
    json(b: unknown) { sent.body = b; return res; },
  };
  return { res: res as unknown as Parameters<typeof readProjectParam>[1], sent };
}

test('readProjectParam: query first, then body; trims; refuses relative; optional yields empty', () => {
  const abs = path.resolve(os.tmpdir(), 'proj');
  const { res, sent } = fakeRes();
  assert.equal(readProjectParam({ query: { project: ` ${abs} ` }, body: { project: 'ignored' } }, res), abs);
  assert.equal(readProjectParam({ query: {}, body: { project: abs } }, res), abs);
  assert.equal(readProjectParam({ query: {}, body: { project: abs } }, res, { source: 'query' }), null);
  assert.equal(sent.status, 400);
  assert.equal(readProjectParam({ query: { project: 'C:developmentproj' }, body: {} }, res), null);
  assert.match(String((sent.body as { error: string }).error), /absolute path/);
  assert.equal(readProjectParam({ query: {}, body: {} }, res, { optional: true }), '');
  assert.equal(readProjectParam({ query: { project: 'rel' }, body: {} }, res, { optional: true }), null);
});

test('project-scoped routes refuse a relative project with 400 and create nothing under the backend cwd', async () => {
  const tmpHome = await mkdtemp(path.join(os.tmpdir(), 'lattice-relproj-'));
  const originalEnv = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
  const rel = `lattice-relproj-probe-${Date.now()}`;
  let server: http.Server | null = null;
  try {
    const { createBackendApp } = await import('../server/app.js');
    const app = createBackendApp({ defaultRoot: tmpHome, backendOrigin: 'http://127.0.0.1:5184' });
    server = http.createServer(app);
    const port = await listen(server);
    const base = `http://127.0.0.1:${port}`;
    const q = `project=${encodeURIComponent(rel)}`;
    const json = { 'Content-Type': 'application/json' };
    const calls: Array<[string, RequestInit?]> = [
      [`/api/settings?${q}`],
      [`/api/settings?${q}`, { method: 'PATCH', headers: json, body: JSON.stringify({ sidebarWidth: 400 }) }],
      [`/api/instruction-templates?${q}`],
      [`/api/harness-system-prompts?${q}`],
      [`/api/project-env?${q}`],
      [`/api/workflows?${q}`],
      ['/api/workflows', { method: 'POST', headers: json, body: JSON.stringify({ project: rel, name: 'x' }) }],
      [`/api/workflow-runs/active?${q}`],
      [`/api/terminal-tabs?${q}`],
      [`/api/terminal-tabs/restore?${q}`, { method: 'POST' }],
      [`/api/terminal-tabs?${q}`, { method: 'PATCH', headers: json, body: JSON.stringify({ order: [] }) }],
      ['/api/merge-runs', { method: 'POST', headers: json, body: JSON.stringify({ project: rel }) }],
      [`/api/merge-runs/active?${q}`],
      [`/api/merge-runs/recovery?${q}`],
      [`/api/post-merge-hooks/active?${q}`],
      ['/api/project-instrumentation', { method: 'POST', headers: json, body: JSON.stringify({ project: rel }) }],
      ['/api/push-runs', { method: 'POST', headers: json, body: JSON.stringify({ project: rel }) }],
      [`/api/git-check?path=${encodeURIComponent(rel)}`],
      ['/api/qa-runs', { method: 'POST', headers: json, body: JSON.stringify({ project: rel, taskId: 't' }) }],
      ['/api/workflow-prompt-customizations', { method: 'POST', headers: json, body: JSON.stringify({ project: rel, prompt: 'p' }) }],
      [`/api/mcp-import/scan?${q}`],
      ['/api/project-init/preview', { method: 'POST', headers: json, body: JSON.stringify({ project: rel }) }],
      ['/api/project-init', { method: 'POST', headers: json, body: JSON.stringify({ project: rel }) }],
      [`/api/opengrep/status?${q}`],
      ['/api/opengrep/scan', { method: 'POST', headers: json, body: JSON.stringify({ project: rel }) }],
      [`/api/opengrep/scans?${q}`],
      ['/api/opengrep/ignore', { method: 'POST', headers: json, body: JSON.stringify({ project: rel, ruleIds: ['r'] }) }],
      ['/api/terminals', { method: 'POST', headers: json, body: JSON.stringify({ cwd: rel }) }],
      // projectPath keys the registry record + MCP resolution, so a relative
      // one registered a phantom project's tab.
      ['/api/terminals', { method: 'POST', headers: json, body: JSON.stringify({ projectPath: rel }) }],
      // The task routes that used to slip through: transition's fromStatus
      // branch, reorder, and the worktree-modified graph read.
      [`/api/tasks/transition?${q}`, { method: 'POST', headers: json, body: JSON.stringify({ fromStatus: 'open', status: 'done' }) }],
      ['/api/tasks/reorder', { method: 'POST', headers: json, body: JSON.stringify({ project: rel, status: 'open', ids: [] }) }],
      [`/api/tasks/worktree-modified?${q}`],
      // The `?path=` / `?project=` read-only graph routes (absent → default
      // root, still; present-but-relative → 400).
      [`/api/search?${q}&q=x`],
      [`/api/search?path=${encodeURIComponent(rel)}&q=x`],
      [`/api/scan?path=${encodeURIComponent(rel)}`],
      [`/api/health/dead-code?${q}`],
      [`/api/git-history?path=${encodeURIComponent(rel)}`],
      [`/api/git-branch?path=${encodeURIComponent(rel)}`],
    ];
    for (const [p, init] of calls) {
      const res = await fetch(base + p, init);
      const body = (await res.json()) as { error?: string };
      assert.equal(res.status, 400, `${init?.method ?? 'GET'} ${p} → ${res.status} ${JSON.stringify(body)}`);
      assert.match(String(body.error), /absolute path/, `${p}: ${body.error}`);
      // Every one names the likely cause, not just the rule.
      assert.match(String(body.error), /backslashes/, `${p}: ${body.error}`);
    }
    // Nothing was born under the backend's cwd for the phantom project.
    await assert.rejects(access(path.join(process.cwd(), rel)));
  } finally {
    if (server) await close(server);
    process.env.HOME = originalEnv.HOME;
    process.env.USERPROFILE = originalEnv.USERPROFILE;
    await rm(tmpHome, { recursive: true, force: true });
    await rm(path.join(process.cwd(), rel), { recursive: true, force: true });
  }
});

// An ABSOLUTE project that doesn't exist: the instrumentation reconcile mkdirs
// `<project>/.claude/`, so a mistyped path used to be born on disk.
test('/api/project-instrumentation refuses a nonexistent project and creates nothing', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'lattice-instr-missing-'));
  const missing = path.join(tmp, 'does-not-exist');
  let server: http.Server | null = null;
  try {
    const { createBackendApp } = await import('../server/app.js');
    const app = createBackendApp({ defaultRoot: tmp, backendOrigin: 'http://127.0.0.1:5184' });
    server = http.createServer(app);
    const port = await listen(server);
    const res = await fetch(`http://127.0.0.1:${port}/api/project-instrumentation`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project: missing }),
    });
    const body = (await res.json()) as { error?: string };
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.match(String(body.error), /not an existing directory/);
    await assert.rejects(access(missing));
  } finally {
    if (server) await close(server);
    await rm(tmp, { recursive: true, force: true });
  }
});

// The WS side of the same rule. `parseProject` used to canonicalise (`path.resolve`)
// BEFORE the endpoint's `listTasks`, which defeated the task cache's read-path
// guard (it only skips indexing when the path it is HANDED is relative) — so
// `ws://…/ws/tasks?project=foo` registered `<backend cwd>/foo` in
// `~/.lattice/projects.json` and wrote a junk identity binding for it.
test('parseProject refuses a relative project (empty ⇒ the socket is closed)', () => {
  assert.equal(parseProject('/ws/tasks?project=foo'), '');
  assert.equal(parseProject('/ws/tasks?project=C%3Adevelopmentproj'), '');
  assert.equal(parseProject('/ws/tasks'), '');
  const abs = path.resolve(os.tmpdir(), 'proj');
  assert.equal(parseProject(`/ws/tasks?project=${encodeURIComponent(abs)}`), canonicalProjectPath(abs));
});

test('/ws/tasks?project=<relative> closes the socket and indexes nothing', async () => {
  const rel = `lattice-relproj-ws-${Date.now()}`;
  const wss = buildTasksWss();
  const server = http.createServer();
  server.on('upgrade', (req, socket, head) => {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });
  const port = await listen(server);
  try {
    const { listKnownProjects } = await import('../tasks.js');
    const client = new WebSocket(`ws://127.0.0.1:${port}/ws/tasks?project=${encodeURIComponent(rel)}`);
    client.on('error', () => { /* a server-side close can surface as an error */ });
    const messages: string[] = [];
    client.on('message', (data) => messages.push(String(data)));
    await new Promise<void>((resolve) => client.once('close', () => resolve()));
    assert.deepEqual(messages, [], 'no snapshot is sent for a refused project');
    const phantom = canonicalProjectPath(rel);
    assert.ok(
      !(await listKnownProjects()).includes(phantom),
      `${phantom} must not be indexed in ~/.lattice/projects.json`,
    );
    await assert.rejects(access(path.join(process.cwd(), rel)));
  } finally {
    wss.close();
    await close(server);
  }
});

// Windows root-relative paths. `path.win32.isAbsolute('/c/development/lattice')`
// is true, but path.resolve pins it to the backend's drive
// (`C:\c\development\lattice`), so a Git-Bash agent's MSYS-style `?project=`
// used to get a 200 with an EMPTY board, and a phantom project was indexed in
// ~/.lattice/projects.json.
test('isRealAbsoluteProjectPath: win32 needs drive-absolute or UNC; POSIX unchanged', () => {
  for (const ok of ['C:\\development\\lattice', 'c:/dev/proj', 'C:\\', '\\\\server\\share\\proj', '//server/share', '\\\\?\\C:\\proj']) {
    assert.equal(isRealAbsoluteProjectPath(ok, 'win32'), true, ok);
  }
  for (const bad of ['/c/development/lattice', '/c', '\\x', '/x', 'C:developmentproj', 'rel', '\\\\server', '']) {
    assert.equal(isRealAbsoluteProjectPath(bad, 'win32'), false, bad);
  }
  assert.equal(isRealAbsoluteProjectPath('/home/me/proj', 'linux'), true);
  assert.equal(isRealAbsoluteProjectPath('/c/development/lattice', 'darwin'), true);
  assert.equal(isRealAbsoluteProjectPath('rel', 'linux'), false);
});

test('relativeProjectError names the MSYS cause and suggests the C:\\ spelling on win32', () => {
  assert.equal(msysToWindowsPath('/c/development/lattice'), 'C:\\development\\lattice');
  assert.equal(msysToWindowsPath('/d'), 'D:\\');
  assert.equal(msysToWindowsPath('\\foo'), null);
  assert.equal(msysToWindowsPath('\\x'), null);
  const msg = relativeProjectError('/c/development/lattice', 'win32');
  assert.match(msg, /absolute path/);
  assert.match(msg, /MSYS/);
  assert.ok(msg.includes(JSON.stringify('C:\\development\\lattice')), msg);
  const rootRel = relativeProjectError('\\x', 'win32');
  assert.match(rootRel, /root-relative/);
  assert.doesNotMatch(rootRel, /MSYS/);
  // POSIX: the relative message is the unchanged one.
  assert.match(relativeProjectError('rel', 'linux'), /backslashes/);
});

test('win32: task reads refuse a root-relative / MSYS project with 400 and index nothing', { skip: process.platform !== 'win32' }, async () => {
  const tmpHome = await mkdtemp(path.join(os.tmpdir(), 'lattice-msysproj-'));
  const originalEnv = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
  let server: http.Server | null = null;
  try {
    const { createBackendApp } = await import('../server/app.js');
    const app = createBackendApp({ defaultRoot: tmpHome, backendOrigin: 'http://127.0.0.1:5184' });
    server = http.createServer(app);
    const port = await listen(server);
    const base = `http://127.0.0.1:${port}`;
    const json = { 'Content-Type': 'application/json' };
    for (const project of ['/c/x', '\\x']) {
      const q = `project=${encodeURIComponent(project)}`;
      const calls: Array<[string, RequestInit?]> = [
        [`/api/tasks?${q}`],
        [`/api/tasks/summary?${q}`],
        [`/api/settings?${q}`],
        [`/api/tasks/transition?${q}`, { method: 'POST', headers: json, body: JSON.stringify({ fromStatus: 'open', status: 'done' }) }],
        ['/api/tasks', { method: 'POST', headers: json, body: JSON.stringify({ project, title: 't' }) }],
      ];
      for (const [p, init] of calls) {
        const res = await fetch(base + p, init);
        const body = (await res.json()) as { error?: string };
        assert.equal(res.status, 400, `${init?.method ?? 'GET'} ${p} → ${res.status} ${JSON.stringify(body)}`);
        assert.match(String(body.error), /absolute path/, `${p}: ${body.error}`);
        assert.match(String(body.error), /root-relative/, `${p}: ${body.error}`);
      }
      assert.equal(parseProject(`/ws/tasks?${q}`), '');
    }
    const { listKnownProjects } = await import('../tasks.js');
    const known = await listKnownProjects();
    for (const phantom of [path.resolve('/c/x'), path.resolve('\\x')]) {
      assert.ok(!known.includes(phantom), `${phantom} must not be indexed`);
    }
  } finally {
    if (server) await close(server);
    process.env.HOME = originalEnv.HOME;
    process.env.USERPROFILE = originalEnv.USERPROFILE;
    await rm(tmpHome, { recursive: true, force: true });
  }
});
