import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { validateProjectForCreate } from '../routes/tasks/projectValidation.js';

const isWindows = process.platform === 'win32';

// These tests exercise the pure fs-probe guard directly and never touch the
// task cache / projects index, so they don't pollute ~/.lattice/projects.json
// (unlike a createTask round-trip).

test('validateProjectForCreate: empty / whitespace project is rejected', async () => {
  for (const p of ['', '   ', null, undefined]) {
    const r = await validateProjectForCreate(p as string);
    assert.equal(r.ok, false);
    assert.match((r as { error: string }).error, /required/);
  }
});

test('validateProjectForCreate: a relative path is rejected (shell-mangling tell)', async () => {
  // The exact flagged failure: `C:\development\lesser_evil` with backslashes
  // eaten arrives as a relative string that path.resolve would silently root
  // at the backend cwd.
  const r = await validateProjectForCreate('developmentlesser_evil');
  assert.equal(r.ok, false);
  assert.match((r as { error: string }).error, /absolute path/);
});

test('validateProjectForCreate: a drive-relative path is rejected', { skip: !isWindows }, async () => {
  const r = await validateProjectForCreate('C:developmentlesser_evil');
  assert.equal(r.ok, false);
  assert.match((r as { error: string }).error, /absolute path/);
});

test('validateProjectForCreate: an absolute but non-existent path is rejected', async () => {
  const missing = path.join(os.tmpdir(), 'lattice-validation-does-not-exist-xyz-12345');
  const r = await validateProjectForCreate(missing);
  assert.equal(r.ok, false);
  assert.match((r as { error: string }).error, /does not exist/);
});

test('validateProjectForCreate: an existing directory that is not a git repo is rejected', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lattice-validation-nogit-'));
  try {
    const r = await validateProjectForCreate(dir);
    assert.equal(r.ok, false);
    assert.match((r as { error: string }).error, /not a git repository/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('validateProjectForCreate: a file path (not a directory) is rejected', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lattice-validation-file-'));
  const file = path.join(dir, 'a-file.txt');
  await fs.writeFile(file, 'x');
  try {
    const r = await validateProjectForCreate(file);
    assert.equal(r.ok, false);
    assert.match((r as { error: string }).error, /not a directory/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('validateProjectForCreate: an existing git repo (.git dir) is accepted, returns canonical', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lattice-validation-git-'));
  await fs.mkdir(path.join(dir, '.git'));
  try {
    const r = await validateProjectForCreate(dir);
    assert.equal(r.ok, true);
    assert.ok((r as { canonical: string }).canonical);
    // Canonical form: on Windows the drive letter is uppercased.
    if (isWindows && /^[a-z]:/.test(dir)) {
      assert.equal((r as { canonical: string }).canonical[0], dir[0].toUpperCase());
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('validateProjectForCreate: a .git FILE (worktree/submodule form) is accepted', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lattice-validation-gitfile-'));
  await fs.writeFile(path.join(dir, '.git'), 'gitdir: /somewhere/else\n');
  try {
    const r = await validateProjectForCreate(dir);
    assert.equal(r.ok, true);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
