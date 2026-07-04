import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { canonicalProjectPath } from '../projectPath.js';
import { createDir, listDir } from '../fsbrowse.js';
import { validateNewFolderName } from '../fsbrowse/validation.js';

async function makeTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'lattice-fsbrowse-'));
}

test('validateNewFolderName trims names and rejects unsafe segments', () => {
  assert.equal(validateNewFolderName('  child  '), 'child');

  assert.throws(() => validateNewFolderName(''), /Folder name is required/);
  assert.throws(() => validateNewFolderName('   '), /Folder name is required/);
  assert.throws(() => validateNewFolderName('.'), /Folder name must not be \. or \.\./);
  assert.throws(() => validateNewFolderName('..'), /Folder name must not be \. or \.\./);
  assert.throws(() => validateNewFolderName('parent/child'), /Folder name must not include path separators/);
  assert.throws(() => validateNewFolderName('parent\\child'), /Folder name must not include path separators/);
  assert.throws(() => validateNewFolderName('bad\0name'), /Folder name must not contain null bytes/);

  if (process.platform === 'win32') {
    assert.throws(() => validateNewFolderName('bad<name'), /characters Windows does not allow/);
    assert.throws(() => validateNewFolderName('trailing.'), /cannot end with a space or period/);

    // Reserved DOS device names are rejected regardless of case or extension.
    for (const reserved of ['CON', 'con', 'PRN', 'AUX', 'NUL', 'NUL.txt', 'COM1', 'com9', 'LPT1', 'LPT9']) {
      assert.throws(
        () => validateNewFolderName(reserved),
        /reserved Windows device name/,
        `expected ${reserved} to be rejected`,
      );
    }
    // Boundary names that are NOT reserved stay allowed.
    for (const allowed of ['COM10', 'LPT10', 'COM0', 'CONSOLE', 'NULable', 'my-con']) {
      assert.equal(validateNewFolderName(allowed), allowed, `expected ${allowed} to be allowed`);
    }
  }
});

test('listDir returns canonical directory listings with visible subfolders only', async () => {
  const root = await makeTempDir();
  try {
    await fs.mkdir(path.join(root, 'b-dir'));
    await fs.mkdir(path.join(root, 'a-dir'));
    await fs.mkdir(path.join(root, '.hidden'));
    await fs.writeFile(path.join(root, 'file.txt'), 'not a directory', 'utf8');

    const canonicalRoot = canonicalProjectPath(root);
    const listing = await listDir(root);

    assert.equal(listing.path, canonicalRoot);
    assert.equal(listing.parent, path.dirname(canonicalRoot));
    assert.ok(listing.roots.length >= 1);
    assert.deepEqual(
      listing.entries.map((entry) => entry.name),
      ['a-dir', 'b-dir'],
    );
    assert.deepEqual(
      listing.entries.map((entry) => entry.path),
      [path.join(canonicalRoot, 'a-dir'), path.join(canonicalRoot, 'b-dir')],
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('listDir rejects files with the existing error shape', async () => {
  const root = await makeTempDir();
  try {
    const file = path.join(root, 'file.txt');
    await fs.writeFile(file, 'not a directory', 'utf8');

    await assert.rejects(
      () => listDir(file),
      (err) => err instanceof Error && err.message === `Not a directory: ${canonicalProjectPath(file)}`,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('createDir validates parent and returns the new folder listing', async () => {
  const root = await makeTempDir();
  try {
    const listing = await createDir(root, '  child  ');
    const expectedPath = canonicalProjectPath(path.join(root, 'child'));

    assert.equal(listing.path, expectedPath);
    assert.equal(listing.parent, canonicalProjectPath(root));
    assert.deepEqual(listing.entries, []);
    assert.ok((await fs.stat(path.join(root, 'child'))).isDirectory());

    await assert.rejects(() => createDir('', 'child'), /Parent path is required/);
    await assert.rejects(() => createDir(root, 'parent/child'), /Folder name must not include path separators/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
