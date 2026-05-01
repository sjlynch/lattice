import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseWorktreesPorcelain } from '../worktree.js';

test('parseWorktreesPorcelain handles main + linked + detached', () => {
  const sample = [
    'worktree C:/dev/lattice',
    'HEAD 1111111111111111111111111111111111111111',
    'branch refs/heads/main',
    '',
    'worktree C:/dev/lattice/.lattice/worktrees/foo',
    'HEAD 2222222222222222222222222222222222222222',
    'branch refs/heads/lattice/foo-abc123',
    '',
    'worktree C:/dev/lattice/.lattice/worktrees/bar',
    'HEAD 3333333333333333333333333333333333333333',
    'detached',
    '',
  ].join('\n');

  const parsed = parseWorktreesPorcelain(sample);
  assert.equal(parsed.length, 3);
  assert.equal(parsed[0].path, 'C:/dev/lattice');
  assert.equal(parsed[0].branch, 'refs/heads/main');
  assert.equal(parsed[1].path, 'C:/dev/lattice/.lattice/worktrees/foo');
  assert.equal(parsed[1].branch, 'refs/heads/lattice/foo-abc123');
  assert.equal(parsed[2].path, 'C:/dev/lattice/.lattice/worktrees/bar');
  assert.equal(parsed[2].detached, true);
  assert.equal(parsed[2].branch, undefined);
});

test('parseWorktreesPorcelain handles empty output', () => {
  assert.deepEqual(parseWorktreesPorcelain(''), []);
  assert.deepEqual(parseWorktreesPorcelain('\n\n\n'), []);
});

test('parseWorktreesPorcelain handles CRLF line endings', () => {
  const crlf =
    'worktree C:/x\r\nHEAD abc\r\nbranch refs/heads/main\r\n\r\n';
  const parsed = parseWorktreesPorcelain(crlf);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].path, 'C:/x');
  assert.equal(parsed[0].branch, 'refs/heads/main');
});
