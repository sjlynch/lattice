import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import ignore from 'ignore';
import { matchIgnoredSourcePath } from '../health/constants.js';

// Regression for a backend crash: deleting (or renaming) a project folder that
// Lattice had open made the Windows recursive watcher report the root as a
// `\\?\C:\…` extended-length path. `path.relative` returned it unchanged, the
// `ignore` package threw `RangeError: path should be a path.relative()d
// string`, and — thrown from an fs.watch callback — that was an
// uncaughtException that took the whole backend down (2026-09-20, three crash
// files in one second).

const root = process.platform === 'win32' ? 'C:\\proj\\app' : '/proj/app';
const gi = ignore().add(['dist/', '*.log']);

test('a \\\\?\\-prefixed path is matched like its plain form instead of throwing', () => {
  if (process.platform !== 'win32') return;
  assert.equal(matchIgnoredSourcePath('\\\\?\\C:\\proj\\app', root, gi, true), false);
  assert.equal(matchIgnoredSourcePath('//?/C:/proj/app', root, gi, true), false);
  assert.equal(matchIgnoredSourcePath('\\\\?\\C:\\proj\\app\\dist\\x.js', root, gi), true);
  assert.equal(matchIgnoredSourcePath('\\\\?\\C:\\proj\\app\\src\\x.ts', root, gi), false);
  // A namespaced ROOT with a plain child path works too.
  assert.equal(matchIgnoredSourcePath('C:\\proj\\app\\node_modules\\x', '\\\\?\\C:\\proj\\app', gi), true);
});

test('paths on another root or outside the project are never ignored and never throw', () => {
  const other = process.platform === 'win32' ? 'D:\\elsewhere\\file.log' : '/elsewhere/file.log';
  assert.equal(matchIgnoredSourcePath(other, root, gi), false);
  assert.equal(matchIgnoredSourcePath(root, root, gi, true), false);
  assert.equal(matchIgnoredSourcePath(path.join(root, '..', 'sibling', 'a.log'), root, gi), false);
});

test('an ignore matcher that throws is treated as "not ignored"', () => {
  const throwing = { ignores: () => { throw new RangeError('boom'); } };
  assert.equal(matchIgnoredSourcePath(path.join(root, 'src', 'a.ts'), root, throwing), false);
});

test('ordinary matching is unchanged', () => {
  assert.equal(matchIgnoredSourcePath(path.join(root, 'dist', 'a.js'), root, gi), true);
  assert.equal(matchIgnoredSourcePath(path.join(root, 'server.log'), root, gi), true);
  assert.equal(matchIgnoredSourcePath(path.join(root, 'node_modules', 'x'), root, gi), true);
  assert.equal(matchIgnoredSourcePath(path.join(root, 'dist'), root, gi, true), true);
  assert.equal(matchIgnoredSourcePath(path.join(root, 'src', 'a.ts'), root, gi), false);
});
