import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { canonicalProjectPath } from '../projectPath.js';
import { createTask, listTasks } from '../tasks.js';

const isWindows = process.platform === 'win32';

test('canonicalProjectPath uppercases Windows drive letters', { skip: !isWindows }, () => {
  assert.equal(canonicalProjectPath('f:\\rust_etl'), 'F:\\rust_etl');
  assert.equal(canonicalProjectPath('F:\\rust_etl'), 'F:\\rust_etl');
  assert.equal(canonicalProjectPath('c:\\Foo\\Bar'), 'C:\\Foo\\Bar');
});

test('canonicalProjectPath is idempotent', () => {
  const a = canonicalProjectPath(os.tmpdir());
  assert.equal(canonicalProjectPath(a), a);
});

test('canonicalProjectPath leaves non-drive paths to path.resolve', () => {
  const cwd = process.cwd();
  assert.equal(canonicalProjectPath('.'), path.resolve('.'));
  assert.equal(canonicalProjectPath(cwd), path.resolve(cwd));
});

test('listTasks finds tasks created with a different drive-letter case', async () => {
  // Use a fresh tmp directory so we're not racing against the user's real projects.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lattice-canon-'));
  try {
    const created = await createTask(dir, 'canonical-case test', 'description');
    assert.ok(created.id);

    if (isWindows && /^[A-Z]:/.test(dir)) {
      // Read back via lowercase drive letter. Should hit the same canonical cache.
      const lower = dir[0].toLowerCase() + dir.slice(1);
      const found = await listTasks(lower);
      assert.equal(found.length, 1);
      assert.equal(found[0].id, created.id);
    } else {
      // Off Windows there's no drive letter case to flip; assert the basic
      // round-trip still works through canonicalization.
      const found = await listTasks(dir);
      assert.equal(found.length, 1);
      assert.equal(found[0].id, created.id);
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
