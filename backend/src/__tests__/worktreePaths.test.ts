import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { isPathInsideRepo } from '../worktree/paths.js';

const repo = path.resolve('/repo');

test('isPathInsideRepo accepts ordinary repo-relative paths', () => {
  assert.equal(isPathInsideRepo(repo, 'src/index.ts'), true);
  assert.equal(isPathInsideRepo(repo, 'docs/readme.md'), true);
  assert.equal(isPathInsideRepo(repo, 'nested/dir/file.txt'), true);
  // A file whose name merely starts with `.git` is fine — only the exact
  // reserved segment is refused.
  assert.equal(isPathInsideRepo(repo, '.gitignore'), true);
  assert.equal(isPathInsideRepo(repo, 'src/.gitkeep'), true);
});

test('isPathInsideRepo rejects paths that escape the repo', () => {
  assert.equal(isPathInsideRepo(repo, '../outside.txt'), false);
  assert.equal(isPathInsideRepo(repo, path.resolve('/elsewhere/x.txt')), false);
  assert.equal(isPathInsideRepo(repo, ''), false);
  assert.equal(isPathInsideRepo(repo, 'has\0nul'), false);
});

test('isPathInsideRepo refuses the in-repo .git directory (BUG 1 guard)', () => {
  // The core of BUG 1: `.git/HEAD` resolves UNDER the repo, so the old
  // escape-only guard let it through and restore could overwrite the gitdir.
  assert.equal(isPathInsideRepo(repo, '.git/HEAD'), false);
  assert.equal(isPathInsideRepo(repo, '.git/config'), false);
  assert.equal(isPathInsideRepo(repo, '.git'), false);
  assert.equal(isPathInsideRepo(repo, '.git/refs/heads/main'), false);
  // The `..\..\.git\HEAD` form named in the threat model resolves right back
  // to <repo>/.git/HEAD from a nested location — still refused.
  assert.equal(isPathInsideRepo(repo, 'a/b/../../.git/HEAD'), false);
  // Case-insensitive: on Windows `.GIT` is the same directory as `.git`.
  assert.equal(isPathInsideRepo(repo, '.GIT/HEAD'), false);
});

test('isPathInsideRepo also refuses .lattice scratch', () => {
  assert.equal(isPathInsideRepo(repo, '.lattice/userSettings.json'), false);
  assert.equal(isPathInsideRepo(repo, '.lattice'), false);
});
