// `LATTICE_PTY_PATH_PREPEND` puts directories ahead of everything else on a
// terminal's PATH — including the registry PATH `applyFreshWindowsPath` puts
// ahead of inherited entries on Windows, which is why an inherited prepend
// alone only ever reached the first terminal after boot.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyPtyPathPrepend } from '../terminal/windowsPath.js';

test('prepends the listed dirs, keeps the PATH key, and drops their later duplicates', () => {
  const env: { [k: string]: string } = {
    Path: 'C:\\reg\\bin;C:\\Soak\\Bin;C:\\other',
    LATTICE_PTY_PATH_PREPEND: 'C:\\soak\\bin',
  };
  applyPtyPathPrepend(env, ';');
  const expected =
    process.platform === 'win32'
      ? 'C:\\soak\\bin;C:\\reg\\bin;C:\\other' // case-folded dedupe on Windows
      : 'C:\\soak\\bin;C:\\reg\\bin;C:\\Soak\\Bin;C:\\other';
  assert.equal(env.Path, expected);
  assert.equal(env.PATH, undefined, 'must not create a second PATH-cased key');
});

test('no-op when the variable is unset or empty', () => {
  const env: { [k: string]: string } = { PATH: '/usr/bin:/bin' };
  applyPtyPathPrepend(env, ':');
  assert.equal(env.PATH, '/usr/bin:/bin');
  env.LATTICE_PTY_PATH_PREPEND = '';
  applyPtyPathPrepend(env, ':');
  assert.equal(env.PATH, '/usr/bin:/bin');
});
