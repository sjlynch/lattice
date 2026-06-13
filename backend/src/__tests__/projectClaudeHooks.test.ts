import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  installProjectClaudeHooks,
  removeProjectClaudeHooks,
} from '../projectClaudeHooks.js';

// installProjectClaudeHooks must MERGE into the user's existing
// .claude/settings.local.json — preserving their permissions and their own
// hooks — be idempotent, and be cleanly removable.

const ORIGIN = 'http://127.0.0.1:5184';

async function mkProject(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lattice-pch-'));
  await fs.mkdir(path.join(dir, '.claude'), { recursive: true });
  return dir;
}

function settingsPath(dir: string): string {
  return path.join(dir, '.claude', 'settings.local.json');
}

async function readSettings(dir: string): Promise<any> {
  return JSON.parse(await fs.readFile(settingsPath(dir), 'utf8'));
}

function latticeGroups(hooks: Record<string, any[]>, event: string): any[] {
  return (hooks[event] ?? []).filter((g: any) =>
    g.hooks?.some((h: any) => h.command?.includes('/api/project-activity/')),
  );
}

test('install merges hooks, preserving the user config', async () => {
  const dir = await mkProject();
  const userConfig = {
    permissions: { allow: ['Bash(npm test *)'] },
    hooks: {
      PreToolUse: [
        { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo mine' }] },
      ],
    },
  };
  await fs.writeFile(settingsPath(dir), JSON.stringify(userConfig, null, 2));

  await installProjectClaudeHooks(dir, ORIGIN);
  const after = await readSettings(dir);

  // User config preserved.
  assert.deepEqual(after.permissions, userConfig.permissions);
  // User's own PreToolUse hook still present.
  assert.ok(
    after.hooks.PreToolUse.some((g: any) => g.hooks[0].command === 'echo mine'),
  );
  // Lattice hooks added on all four events.
  for (const event of ['PreToolUse', 'PostToolUse', 'SessionStart', 'SessionEnd']) {
    assert.equal(latticeGroups(after.hooks, event).length, 1, `${event} added`);
  }

  await fs.rm(dir, { recursive: true, force: true });
});

test('install is idempotent (no duplicate Lattice groups, stable bytes)', async () => {
  const dir = await mkProject();
  await fs.writeFile(settingsPath(dir), JSON.stringify({ permissions: {} }));

  await installProjectClaudeHooks(dir, ORIGIN);
  const first = await fs.readFile(settingsPath(dir), 'utf8');
  await installProjectClaudeHooks(dir, ORIGIN);
  const second = await fs.readFile(settingsPath(dir), 'utf8');

  assert.equal(first, second, 'second install is byte-identical');
  const after = await readSettings(dir);
  assert.equal(latticeGroups(after.hooks, 'PreToolUse').length, 1, 'no dupes');

  await fs.rm(dir, { recursive: true, force: true });
});

test('remove strips only Lattice hooks, keeping user hooks + permissions', async () => {
  const dir = await mkProject();
  const userConfig = {
    permissions: { allow: ['Bash(git *)'] },
    hooks: {
      PreToolUse: [
        { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo mine' }] },
      ],
    },
  };
  await fs.writeFile(settingsPath(dir), JSON.stringify(userConfig, null, 2));

  await installProjectClaudeHooks(dir, ORIGIN);
  await removeProjectClaudeHooks(dir);
  const after = await readSettings(dir);

  assert.deepEqual(after.permissions, userConfig.permissions);
  // User's PreToolUse hook survives; Lattice's are gone; empty events dropped.
  assert.equal(after.hooks.PreToolUse.length, 1);
  assert.equal(after.hooks.PreToolUse[0].hooks[0].command, 'echo mine');
  assert.ok(!('SessionStart' in after.hooks), 'lattice-only event removed');

  await fs.rm(dir, { recursive: true, force: true });
});

test('install creates the file when absent', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lattice-pch2-'));
  await installProjectClaudeHooks(dir, ORIGIN);
  const after = await readSettings(dir);
  assert.equal(latticeGroups(after.hooks, 'SessionStart').length, 1);
  await fs.rm(dir, { recursive: true, force: true });
});
