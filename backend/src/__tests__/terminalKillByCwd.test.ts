import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cwdIsAtOrUnder, POST_KILL_CHECK_DELAY_MS, schedulePostKillConfigCheck } from '../terminal/kill.js';

// A burst of kills (kill-by-cwd, shutdown) must cost ONE ~/.claude.json check,
// run a full delay after the last kill, not one synchronous read per session.
test('post-kill config checks are debounced across a burst of kills', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let checks = 0;
  const check = async () => { checks += 1; };
  schedulePostKillConfigCheck(check);
  t.mock.timers.tick(POST_KILL_CHECK_DELAY_MS - 1);
  schedulePostKillConfigCheck(check);
  schedulePostKillConfigCheck(check);
  t.mock.timers.tick(POST_KILL_CHECK_DELAY_MS - 1);
  assert.equal(checks, 0);
  t.mock.timers.tick(1);
  assert.equal(checks, 1);
  t.mock.timers.tick(POST_KILL_CHECK_DELAY_MS * 2);
  assert.equal(checks, 1);
});

// The terminal-server's kill-by-cwd predicate (worktree teardown releases the
// worktree's Windows file locks through it). It must agree with the backend's
// own "is a pty alive under this worktree" checks, which compare
// separator-agnostically — a mixed-separator pair used to be "alive" there but
// "nothing to kill" here, leaving the pty holding its locks.

test('mixed path separators still match on Windows', () => {
  assert.equal(cwdIsAtOrUnder('C:\\Users\\me\\.lattice\\worktrees\\h\\slug-1', 'C:/Users/me/.lattice/worktrees/h/slug-1', 'win32'), true);
  assert.equal(cwdIsAtOrUnder('C:\\Users\\me\\.lattice\\worktrees\\h\\slug-1\\backend', 'C:/Users/me/.lattice/worktrees/h/slug-1/', 'win32'), true);
  assert.equal(cwdIsAtOrUnder('c:/users/ME/wt', 'C:\\Users\\me\\wt\\', 'win32'), true);
});

test('a sibling that merely shares a prefix is never matched', () => {
  assert.equal(cwdIsAtOrUnder('C:\\wt\\slug-10', 'C:\\wt\\slug-1', 'win32'), false);
  assert.equal(cwdIsAtOrUnder('/home/me/wt/slug-10', '/home/me/wt/slug-1', 'linux'), false);
});

test('POSIX paths are case-sensitive', () => {
  assert.equal(cwdIsAtOrUnder('/home/me/WT/a', '/home/me/wt', 'linux'), false);
  assert.equal(cwdIsAtOrUnder('/home/me/wt/a', '/home/me/wt/', 'linux'), true);
});
