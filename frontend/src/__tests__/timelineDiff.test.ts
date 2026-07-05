import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { GraphNode, ScanResult } from '../api/types/scan.ts';
import type { GitCommit, GitUncommitted } from '../api/types/gitHistory.ts';
import {
  GHOST_PREFIX,
  relForward,
  buildGhostGraphData,
} from '../components/forceGraph/timelineDiff.ts';

function dir(path: string, id = path): GraphNode {
  return { id, name: path.split(/[\\/]/).pop() || path, path, kind: 'dir' };
}
function file(path: string, ext?: string): GraphNode {
  return { id: path, name: path.split(/[\\/]/).pop() || path, path, kind: 'file', ext };
}
function commit(changes: GitCommit['changes']): GitCommit {
  return {
    sha: 'deadbeefcafe',
    shortSha: 'deadbee',
    subject: 'change',
    authorName: 'me',
    date: 0,
    changes,
  };
}
function noUncommitted(): GitUncommitted {
  return { changes: [] };
}

test('relForward normalizes a Windows absolute path under the root to a forward-relative path', () => {
  assert.equal(relForward('C:\\repo\\src\\components\\a.ts', 'C:\\repo'), 'src/components/a.ts');
  // Root that already carries a trailing separator still strips exactly one.
  assert.equal(relForward('C:\\repo\\src\\a.ts', 'C:\\repo\\'), 'src/a.ts');
  // POSIX behaves identically.
  assert.equal(relForward('/repo/src/a.ts', '/repo'), 'src/a.ts');
});

test('relForward passes through paths not under the root, only swapping backslashes', () => {
  // No root → just normalize separators.
  assert.equal(relForward('C:\\repo\\a.ts', ''), 'C:/repo/a.ts');
  // Under a different drive/prefix → not made relative, just normalized.
  assert.equal(relForward('D:\\other\\x.ts', 'C:\\repo'), 'D:/other/x.ts');
});

test('buildGhostGraphData ghosts only history paths missing from the scan (Windows scan)', () => {
  const scan: ScanResult = {
    root: 'C:\\repo',
    nodes: [
      dir('C:\\repo'),
      dir('C:\\repo\\src'),
      dir('C:\\repo\\src\\old'),
      file('C:\\repo\\src\\keep.ts', '.ts'),
    ],
    links: [],
  };
  const commits: GitCommit[] = [
    commit([
      { path: 'src/keep.ts', status: 'M' }, // present in scan → not ghosted
      { path: 'src/old/deleted.TS', status: 'D' },
    ]),
    // Same historical path in a second commit must not mint a second ghost.
    commit([{ path: 'src/old/deleted.TS', status: 'A' }]),
  ];
  // ...and again in the uncommitted set → still a single ghost.
  const uncommitted: GitUncommitted = { changes: [{ path: 'src/old/deleted.TS', status: 'M' }] };

  const { ghostNodes, ghostLinks } = buildGhostGraphData(scan, commits, uncommitted);

  assert.equal(ghostNodes.length, 1);
  const ghost = ghostNodes[0];
  assert.equal(ghost.id, `${GHOST_PREFIX}src/old/deleted.TS`);
  assert.equal(ghost.name, 'deleted.TS');
  assert.equal(ghost.path, 'src/old/deleted.TS');
  assert.equal(ghost.kind, 'file');
  assert.equal(ghost.__ghost, true);
  // ext is lowercased even though the source path was upper-case.
  assert.equal(ghost.ext, '.ts');

  // Linked under the nearest existing directory node (src/old), by its id.
  assert.equal(ghostLinks.length, 1);
  assert.deepEqual(ghostLinks[0], {
    source: 'C:\\repo\\src\\old',
    target: `${GHOST_PREFIX}src/old/deleted.TS`,
  });
});

test('buildGhostGraphData walks up to the nearest existing ancestor directory', () => {
  const scan: ScanResult = {
    root: 'C:\\repo',
    nodes: [dir('C:\\repo'), dir('C:\\repo\\src')], // no src/old dir
    links: [],
  };
  const { ghostLinks } = buildGhostGraphData(
    scan,
    [commit([{ path: 'src/old/deleted.ts', status: 'D' }])],
    noUncommitted(),
  );
  assert.deepEqual(ghostLinks, [
    { source: 'C:\\repo\\src', target: `${GHOST_PREFIX}src/old/deleted.ts` },
  ]);
});

test('buildGhostGraphData falls back to the scan root when no ancestor dir exists', () => {
  const scan: ScanResult = {
    root: 'C:\\repo',
    nodes: [dir('C:\\repo')], // only the root dir
    links: [],
  };
  const { ghostNodes, ghostLinks } = buildGhostGraphData(
    scan,
    [
      commit([
        { path: 'src/old/deleted.ts', status: 'D' }, // nested, no ancestor → root
        { path: 'Makefile', status: 'D' }, // no slash at all → root
      ]),
    ],
    noUncommitted(),
  );
  assert.equal(ghostNodes.length, 2);
  const bySource = new Map(ghostLinks.map((l) => [l.target, l.source]));
  assert.equal(bySource.get(`${GHOST_PREFIX}src/old/deleted.ts`), 'C:\\repo');
  assert.equal(bySource.get(`${GHOST_PREFIX}Makefile`), 'C:\\repo');
  // A file with no extension yields an empty ext.
  const topLevel = ghostNodes.find((n) => n.path === 'Makefile')!;
  assert.equal(topLevel.ext, '');
});

test('buildGhostGraphData produces no ghosts when every history path is still in the scan', () => {
  const scan: ScanResult = {
    root: 'C:\\repo',
    nodes: [dir('C:\\repo'), dir('C:\\repo\\src'), file('C:\\repo\\src\\a.ts', '.ts')],
    links: [],
  };
  const { ghostNodes, ghostLinks } = buildGhostGraphData(
    scan,
    [commit([{ path: 'src/a.ts', status: 'M' }])],
    { changes: [{ path: 'src/a.ts', status: 'M' }] },
  );
  assert.deepEqual(ghostNodes, []);
  assert.deepEqual(ghostLinks, []);
});
