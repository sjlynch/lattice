import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeDeletedPaths } from '../gitHistory/deletedPaths.js';
import type { GitCommit, GitCommitChange, GitUncommitted } from '../gitHistory/types.js';

function commit(changes: GitCommitChange[], shortSha = 'abc1234'): GitCommit {
  return {
    sha: shortSha.padEnd(40, '0'),
    shortSha,
    subject: 'change',
    body: '',
    authorName: 'me',
    date: 0,
    changes,
  };
}
function none(): GitUncommitted {
  return { changes: [] };
}

test('computeDeletedPaths reports a history path git no longer tracks', () => {
  const commits = [commit([{ path: 'src/gone.ts', status: 'D' }])];
  assert.deepEqual(computeDeletedPaths(commits, none(), new Set(['src/kept.ts'])), [
    'src/gone.ts',
  ]);
});

test('computeDeletedPaths never reports a tracked file, whatever its history says', () => {
  // THE regression. The scan is extension-filtered, so these never appear as
  // graph nodes; ghosting them on "missing from the scan" drew every tracked
  // image/font/.ico/.gitignore as a deleted file on the commit that ADDED it.
  const commits = [
    commit([
      { path: 'app/page.tsx', status: 'A' },
      { path: 'public/images/board.jpg', status: 'A' },
      { path: 'fonts/Inter-Bold.ttf', status: 'A' },
      { path: 'app/favicon.ico', status: 'A' },
      { path: '.gitignore', status: 'A' },
    ]),
    commit([{ path: 'public/images/board.jpg', status: 'M' }]),
  ];
  const tracked = new Set([
    'app/page.tsx',
    'public/images/board.jpg',
    'fonts/Inter-Bold.ttf',
    'app/favicon.ico',
    '.gitignore',
  ]);
  assert.deepEqual(computeDeletedPaths(commits, none(), tracked), []);
});

test('computeDeletedPaths sees a deletion whose commit is not the newest in log order', () => {
  // `git log` sorts by commit DATE and --no-merges drops the merges, so two
  // children of one parent interleave. Lattice runs every task on its own
  // branch, so this is its normal history shape: a sibling branch's `M` lands
  // after the branch that actually deleted the file. Reading "the newest status
  // in log order" would call this file alive; git says otherwise.
  const commits = [
    commit([{ path: 'backend/health.test.ts', status: 'D' }], 'deleter'), // 14:07
    commit([{ path: 'backend/health.test.ts', status: 'M' }], 'sibling'), // 14:43
  ];
  assert.deepEqual(computeDeletedPaths(commits, none(), new Set()), [
    'backend/health.test.ts',
  ]);
});

test('computeDeletedPaths reports a tracked file deleted in the working tree only', () => {
  // Still in the index (so `git ls-files` lists it), removed on disk.
  const uncommitted: GitUncommitted = { changes: [{ path: 'src/a.ts', status: 'D' }] };
  assert.deepEqual(computeDeletedPaths([], uncommitted, new Set(['src/a.ts'])), ['src/a.ts']);
});

test('computeDeletedPaths does not report an untracked or modified working-tree path', () => {
  const uncommitted: GitUncommitted = {
    changes: [
      { path: 'src/new.ts', status: 'A' }, // untracked or staged add
      { path: 'src/edited.ts', status: 'M' },
    ],
  };
  const tracked = new Set(['src/new.ts', 'src/edited.ts']);
  assert.deepEqual(computeDeletedPaths([], uncommitted, tracked), []);
});

test('computeDeletedPaths reports a rename source but not its destination', () => {
  // parseLog decomposes `R old new` into {old: D} + {new: A}.
  const commits = [
    commit([
      { path: 'old/banner.png', status: 'D' },
      { path: 'new/banner.png', status: 'A', oldPath: 'old/banner.png' },
    ]),
  ];
  assert.deepEqual(computeDeletedPaths(commits, none(), new Set(['new/banner.png'])), [
    'old/banner.png',
  ]);
});

test('computeDeletedPaths ignores a path deleted and later re-added', () => {
  const commits = [
    commit([{ path: 'logo.png', status: 'D' }]),
    commit([{ path: 'logo.png', status: 'A' }]),
  ];
  assert.deepEqual(computeDeletedPaths(commits, none(), new Set(['logo.png'])), []);
});

test('computeDeletedPaths returns a deduped, sorted list', () => {
  const commits = [
    commit([{ path: 'b.ts', status: 'D' }, { path: 'a.ts', status: 'M' }]),
    commit([{ path: 'b.ts', status: 'M' }]),
  ];
  assert.deepEqual(computeDeletedPaths(commits, none(), new Set()), ['a.ts', 'b.ts']);
});

test('computeDeletedPaths reports nothing when the tracked-file probe failed', () => {
  // null means "we do not know". Reporting everything as deleted would be the
  // exact false positive this module exists to prevent, so we report nothing
  // and lose the ghosts for that one request instead.
  const commits = [commit([{ path: 'src/gone.ts', status: 'D' }])];
  assert.deepEqual(computeDeletedPaths(commits, none(), null), []);
});
