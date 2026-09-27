import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { getUserSettings, patchUserSettings, userSettingsShapeError } from '../userSettings.js';
import { scan } from '../scanner.js';

// Regression: `deadCodeEntryGlobs` (never written by the UI — only by hand or
// an API/agent PATCH) was stored and read back verbatim. A string
// (`"src/routes/**"`) made every `/api/scan` and `/api/health/dead-code` throw
// `globs.map is not a function` — the 3D graph never loaded — and closed
// `/ws/health`; `[null, …]` crashed in `globToRegExp`. A non-string
// `postMergeHookPrompt` threw in the post-merge trigger's `.trim()`. The
// storage boundary now heals these on read, and the PATCH route 400s them.

async function mkProject(settings?: unknown): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lattice-settings-shape-'));
  if (settings !== undefined) {
    await fs.mkdir(path.join(dir, '.lattice'), { recursive: true });
    await fs.writeFile(path.join(dir, '.lattice', 'userSettings.json'), JSON.stringify(settings), 'utf8');
  }
  return dir;
}

test('getUserSettings heals a non-array deadCodeEntryGlobs / metricsIgnoredExts and non-string prompts', async () => {
  const dir = await mkProject({
    deadCodeEntryGlobs: 'src/**',
    metricsIgnoredExts: { '.json': true },
    postMergeHookPrompt: 42,
    piModel: ['x'],
    postMergeHookPiModel: null,
    sidebarWidth: 300,
  });
  try {
    const s = await getUserSettings(dir);
    assert.equal(s.deadCodeEntryGlobs, undefined);
    assert.equal(s.metricsIgnoredExts, undefined);
    assert.equal(s.postMergeHookPrompt, undefined);
    assert.equal(s.piModel, undefined);
    assert.equal(s.postMergeHookPiModel, undefined);
    assert.equal(s.sidebarWidth, 300, 'unrelated fields survive');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('getUserSettings drops null / non-string / blank entries from the glob arrays', async () => {
  const dir = await mkProject({ deadCodeEntryGlobs: [null, 'a/**', 7, '  '], metricsIgnoredExts: ['.md', null] });
  try {
    const s = await getUserSettings(dir);
    assert.deepEqual(s.deadCodeEntryGlobs, ['a/**']);
    assert.deepEqual(s.metricsIgnoredExts, ['.md']);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

for (const [label, globs] of [
  ['a string', 'src/**'],
  ['an array holding null', [null, 'a/**']],
] as const) {
  test(`scan succeeds when userSettings.json holds deadCodeEntryGlobs as ${label}`, async () => {
    const dir = await mkProject({ deadCodeEntryGlobs: globs });
    try {
      await fs.mkdir(path.join(dir, 'a'), { recursive: true });
      await fs.writeFile(path.join(dir, 'a', 'x.ts'), 'export const x = 1;\n', 'utf8');
      const result = await scan(dir);
      assert.ok(Array.isArray(result.nodes));
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
}

test('patchUserSettings never lands a malformed value (a bad one clears the field)', async () => {
  const dir = await mkProject({ deadCodeEntryGlobs: ['keep/**'] });
  try {
    const out = await patchUserSettings(dir, {
      deadCodeEntryGlobs: 'src/**' as unknown as string[],
      postMergeHookPrompt: 5 as unknown as string,
    });
    assert.equal(out.deadCodeEntryGlobs, undefined);
    assert.equal(out.postMergeHookPrompt, undefined);
    const onDisk = JSON.parse(await fs.readFile(path.join(dir, '.lattice', 'userSettings.json'), 'utf8'));
    assert.equal('deadCodeEntryGlobs' in onDisk, false);
    assert.equal('postMergeHookPrompt' in onDisk, false);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('userSettingsShapeError: flags bad shapes, allows well-formed values and null', () => {
  assert.equal(userSettingsShapeError({ sidebarWidth: 1 }), null);
  assert.equal(userSettingsShapeError({ deadCodeEntryGlobs: ['a/**'], metricsIgnoredExts: [] }), null);
  assert.equal(userSettingsShapeError({ deadCodeEntryGlobs: null, postMergeHookPrompt: null }), null);
  assert.equal(userSettingsShapeError({ postMergeHookPrompt: 'run it', piModel: 'p/m' }), null);
  assert.match(String(userSettingsShapeError({ deadCodeEntryGlobs: 'src/**' })), /deadCodeEntryGlobs must be an array of strings/);
  assert.match(String(userSettingsShapeError({ metricsIgnoredExts: ['.md', null] })), /metricsIgnoredExts/);
  assert.match(String(userSettingsShapeError({ postMergeHookPrompt: 3 })), /postMergeHookPrompt must be a string/);
});

test('PATCH /api/settings 400s a non-array deadCodeEntryGlobs and writes nothing', async () => {
  const dir = await mkProject();
  let server: http.Server | null = null;
  try {
    const { createBackendApp } = await import('../server/app.js');
    const app = createBackendApp({ defaultRoot: dir, backendOrigin: 'http://127.0.0.1:5184' });
    server = http.createServer(app);
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    const res = await fetch(`http://127.0.0.1:${port}/api/settings?project=${encodeURIComponent(dir)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deadCodeEntryGlobs: 'src/routes/**' }),
    });
    const body = (await res.json()) as { error?: string };
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.match(String(body.error), /deadCodeEntryGlobs/);
    await assert.rejects(fs.access(path.join(dir, '.lattice', 'userSettings.json')));
  } finally {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    await fs.rm(dir, { recursive: true, force: true });
  }
});
