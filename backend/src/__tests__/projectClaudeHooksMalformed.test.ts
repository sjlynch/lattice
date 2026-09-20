import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import {
  installProjectClaudeHooks,
  removeProjectClaudeHooks,
  setProjectClaudeMemoryDisabled,
} from '../projectClaudeHooks.js';

// `<project>/.claude/settings.local.json` is the USER's file (their
// permissions, env, hooks). The writers used to parse it with a catch-all
// `?? {}`, so a file that EXISTS but does not parse — mid-edit, a trailing
// comma, an array root — was replaced wholesale with just Lattice's entries.
// Now a malformed file is left byte-for-byte alone, and the rewrite of a
// healthy one goes through temp + rename (no truncated file on a kill).

async function withProject(fn: (root: string, file: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lattice-claude-hooks-'));
  try {
    await mkdir(path.join(root, '.claude'), { recursive: true });
    await fn(root, path.join(root, '.claude', 'settings.local.json'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const MALFORMED_BODIES = [
  '{ "permissions": { "allow": ["Bash(npm test)"], }',
  '[1, 2, 3]',
  '"just a string"',
  '',
];

test('a settings.local.json that does not parse is never overwritten', async () => {
  for (const body of MALFORMED_BODIES) {
    await withProject(async (root, file) => {
      await writeFile(file, body, 'utf8');
      await installProjectClaudeHooks(root, 'http://127.0.0.1:5184');
      assert.equal(await readFile(file, 'utf8'), body, `install left ${JSON.stringify(body)} alone`);
      await setProjectClaudeMemoryDisabled(root, true);
      assert.equal(await readFile(file, 'utf8'), body, `memory reconcile left ${JSON.stringify(body)} alone`);
      await removeProjectClaudeHooks(root);
      assert.equal(await readFile(file, 'utf8'), body, `removal left ${JSON.stringify(body)} alone`);
      // No temp file left behind either.
      assert.deepEqual(await readdir(path.join(root, '.claude')), ['settings.local.json']);
    });
  }
});

test('a healthy file keeps every user key across install + remove, with no temp file left', async () => {
  await withProject(async (root, file) => {
    const user = {
      permissions: { allow: ['Bash(npm test)'] },
      env: { FOO: 'bar' },
      hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo mine' }] }] },
    };
    await writeFile(file, JSON.stringify(user, null, 2), 'utf8');
    await installProjectClaudeHooks(root, 'http://127.0.0.1:5184');
    const installed = JSON.parse(await readFile(file, 'utf8')) as typeof user & { hooks: Record<string, unknown[]> };
    assert.deepEqual(installed.permissions, user.permissions);
    assert.deepEqual(installed.env, user.env);
    assert.equal(installed.hooks.PreToolUse.length, 2, "the user's own PreToolUse group survives beside Lattice's");
    assert.ok(installed.hooks.SessionStart, 'Lattice hooks were added');
    await removeProjectClaudeHooks(root);
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), user, 'removal restores the user file exactly');
    assert.deepEqual(await readdir(path.join(root, '.claude')), ['settings.local.json']);
  });
});
