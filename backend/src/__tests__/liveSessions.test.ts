import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { normalizeCwd, hasLiveSessionAtOrUnder } from '../recovery/liveSessions.js';

// Pure-function coverage for the live-PTY guard the boot sweeps use to avoid
// reclaiming a still-running QA/push session after a backend restart. Paths are
// built from os.tmpdir() so they're absolute on both Windows and POSIX; the
// functions never touch disk, so nothing is created.
const base = path.join(os.tmpdir(), 'lattice-live-sessions-test');
const qaDir = path.join(base, 'qa', 'qa_1781884796823_3ea9a9');

test('normalizeCwd strips trailing separators', () => {
  assert.equal(normalizeCwd(qaDir + path.sep), normalizeCwd(qaDir));
  assert.equal(normalizeCwd(qaDir + '/'), normalizeCwd(qaDir));
});

test('normalizeCwd: case-insensitive on win32, case-sensitive elsewhere', () => {
  const lower = normalizeCwd(qaDir.toLowerCase());
  const upper = normalizeCwd(qaDir.toUpperCase());
  if (process.platform === 'win32') {
    assert.equal(lower, upper);
  } else {
    assert.notEqual(lower, upper);
  }
});

test('hasLiveSessionAtOrUnder: exact cwd match', () => {
  const live = new Set([normalizeCwd(qaDir)]);
  assert.equal(hasLiveSessionAtOrUnder(live, qaDir), true);
});

test('hasLiveSessionAtOrUnder: a cwd nested under the dir matches', () => {
  const nested = path.join(qaDir, 'sub', 'deeper');
  const live = new Set([normalizeCwd(nested)]);
  assert.equal(hasLiveSessionAtOrUnder(live, qaDir), true);
});

test('hasLiveSessionAtOrUnder: a sibling dir does not match', () => {
  const sibling = path.join(base, 'qa', 'qa_999_zzz');
  const live = new Set([normalizeCwd(sibling)]);
  assert.equal(hasLiveSessionAtOrUnder(live, qaDir), false);
});

test('hasLiveSessionAtOrUnder: an ancestor cwd does not match (only at-or-under)', () => {
  const parent = path.join(base, 'qa');
  const live = new Set([normalizeCwd(parent)]);
  assert.equal(hasLiveSessionAtOrUnder(live, qaDir), false);
});

test('hasLiveSessionAtOrUnder: a string-prefix lookalike does not match', () => {
  // qa_…_3ea9a9 vs qa_…_3ea9a9_extra — shares a string prefix but is not a
  // path child, so the norm+sep boundary check must reject it.
  const lookalike = qaDir + '_extra';
  const live = new Set([normalizeCwd(lookalike)]);
  assert.equal(hasLiveSessionAtOrUnder(live, qaDir), false);
});

test('hasLiveSessionAtOrUnder: empty live set never matches', () => {
  assert.equal(hasLiveSessionAtOrUnder(new Set(), qaDir), false);
});

test('hasLiveSessionAtOrUnder: matches case-insensitively on win32', () => {
  const live = new Set([normalizeCwd(qaDir.toUpperCase())]);
  assert.equal(hasLiveSessionAtOrUnder(live, qaDir), process.platform === 'win32');
});
