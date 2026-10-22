import { test, expect, type APIRequestContext } from '@playwright/test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

// Fleet against the REAL isolated backend + executor, with a plain shell — no
// coding harness, nothing billed. A disposable git project gets one task (so
// it is known) and one shell terminal. Checks: the snapshot lists the project
// and its terminal; an agent-style request (no browser headers) is refused
// control while `fleetAgentControl` is off; a browser request types into the
// shell, waits for it and reads the output back; the navbar Fleet panel shows
// the project, opens that terminal's live screen and types into it.

const ACTIVE_FOLDER_KEY = 'lattice.activeFolder';
const BROWSER = { 'sec-fetch-site': 'same-origin' };
let projectDir = '';
let taskId = '';
let ptyId = '';

function git(cwd: string, args: string[]): void {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr || r.stdout}`);
}

async function json<T>(response: Awaited<ReturnType<APIRequestContext['get']>>): Promise<T> {
  expect(response.ok(), await response.text()).toBe(true);
  return response.json() as Promise<T>;
}

async function screenText(request: APIRequestContext): Promise<string> {
  const s = await json<{ tail: string }>(await request.get(`/api/terminals/${ptyId}/screen?lines=200`, { headers: BROWSER }));
  return s.tail;
}

test.beforeAll(async ({ request }) => {
  projectDir = path.resolve(await fs.mkdtemp(path.join(os.tmpdir(), 'lattice-playwright-fleet-')));
  git(projectDir, ['init', '-q']);
  git(projectDir, ['config', 'user.name', 'Lattice Playwright']);
  git(projectDir, ['config', 'user.email', 'playwright@lattice.test']);
  await fs.writeFile(path.join(projectDir, 'README.md'), '# fleet e2e\n', 'utf8');
  git(projectDir, ['add', 'README.md']);
  git(projectDir, ['commit', '-q', '-m', 'fixture']);
  taskId = (await json<{ id: string }>(await request.post('/api/tasks', { data: { project: projectDir, title: 'Fleet fixture task' } }))).id;
  ptyId = (await json<{ id: string }>(await request.post('/api/terminals', {
    data: { cwd: projectDir, projectPath: projectDir, label: 'fleet-e2e shell', cols: 100, rows: 30 },
  }))).id;
});

test.afterAll(async ({ request }) => {
  if (ptyId) await request.delete(`/api/terminals/${ptyId}`).catch(() => {});
  if (taskId) await request.delete(`/api/tasks/${taskId}?project=${encodeURIComponent(projectDir)}`).catch(() => {});
  // Bounded: only a direct child of the OS temp dir that this spec created.
  if (projectDir && path.dirname(projectDir) === path.resolve(os.tmpdir()) && path.basename(projectDir).startsWith('lattice-playwright-fleet-')) {
    await new Promise((r) => setTimeout(r, 500));
    await fs.rm(projectDir, { recursive: true, force: true }).catch(() => {});
  }
});

test('fleet API: snapshot, agent gate, type → wait → read back', async ({ request }) => {
  type Snap = { projects: Array<{ path: string; terminals: Array<{ id: string; label: string }> }>; agentControl: boolean };
  const mineIn = (snap: Snap) => snap.projects.find((p) => path.resolve(p.path).toLowerCase() === projectDir.toLowerCase());
  await expect.poll(async () => mineIn(await json<Snap>(await request.get('/api/fleet')))?.terminals.map((t) => t.id) ?? [], { timeout: 10000 }).toContain(ptyId);
  expect((await json<Snap>(await request.get('/api/fleet'))).agentControl).toBe(false);

  const refused = await request.post(`/api/terminals/${ptyId}/input`, { data: { text: 'echo no', submit: true } });
  expect(refused.status()).toBe(403);

  await json(await request.post(`/api/terminals/${ptyId}/input`, { headers: BROWSER, data: { text: 'echo fleet-ok-123', submit: true } }));
  await json(await request.post(`/api/terminals/${ptyId}/wait-idle`, { headers: BROWSER, data: { quietMs: 800, timeoutMs: 15000 } }));
  await expect.poll(() => screenText(request), { timeout: 15000 }).toContain('fleet-ok-123');
});

test('fleet panel: project card, terminal screen, typing into it', async ({ page, request }) => {
  await page.addInitScript(([key, dir]) => sessionStorage.setItem(key, dir), [ACTIVE_FOLDER_KEY, projectDir] as const);
  await page.goto('/');
  await page.getByRole('button', { name: 'Open Fleet' }).click();
  const name = path.basename(projectDir);
  await expect(page.locator('.fleet-card', { hasText: name })).toBeVisible({ timeout: 15000 });
  await page.locator('.fleet-card', { hasText: name }).getByRole('button', { name: 'fleet-e2e shell' }).click();
  const screen = page.locator('.fleet-term-screen');
  await expect(screen).not.toHaveText('…', { timeout: 15000 });
  await page.getByLabel('Text to send').fill('echo ui-typed-456');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(screen).toContainText('ui-typed-456', { timeout: 15000 });
  // What the panel typed really reached the pty.
  await expect.poll(() => screenText(request), { timeout: 15000 }).toContain('ui-typed-456');
});
