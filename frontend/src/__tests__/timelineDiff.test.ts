import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { GraphNode, ScanResult } from '../api/types/scan.ts';
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

test('relForward normalizes a Windows absolute path under the root to a forward-relative path', () => {
  assert.equal(relForward('C:\\repo\\src\\components\\a.ts', 'C:\\repo'), 'src/components/a.ts');
  // Root that already carries a trailing separator still strips exactly one.
  assert.equal(relForward('C:\\repo\\src\\a.ts', 'C:\\repo\\'), 'src/a.ts');
  // POSIX behaves identically.
  assert.equal(relForward('/repo/src/a.ts', '/repo'), 'src/a.ts');
});

test('relForward passes through paths not under the root, only swapping backslashes', () => {
  // No root -> just normalize separators.
  assert.equal(relForward('C:\\repo\\a.ts', ''), 'C:/repo/a.ts');
  // Under a different drive/prefix -> not made relative, just normalized.
  assert.equal(relForward('D:\\other\\x.ts', 'C:\\repo'), 'D:/other/x.ts');
});

test('buildGhostGraphData mints one ghost per backend-reported deleted path (Windows scan)', () => {
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

  const { ghostNodes, ghostLinks } = buildGhostGraphData(scan, ['src/old/deleted.TS']);

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

test('buildGhostGraphData never ghosts a path that is still in the scan', () => {
  // Scan and history are fetched independently, so a path can briefly appear in
  // both. The scan wins: a node that exists must not also get a ghost twin.
  const scan: ScanResult = {
    root: 'C:\\repo',
    nodes: [dir('C:\\repo'), dir('C:\\repo\\src'), file('C:\\repo\\src\\a.ts', '.ts')],
    links: [],
  };
  const { ghostNodes, ghostLinks } = buildGhostGraphData(scan, ['src/a.ts']);
  assert.deepEqual(ghostNodes, []);
  assert.deepEqual(ghostLinks, []);
});

test('buildGhostGraphData dedupes a repeated deleted path', () => {
  const scan: ScanResult = { root: 'C:\\repo', nodes: [dir('C:\\repo')], links: [] };
  const { ghostNodes } = buildGhostGraphData(scan, ['gone.ts', 'gone.ts']);
  assert.equal(ghostNodes.length, 1);
});

test('buildGhostGraphData produces nothing for an empty deleted set', () => {
  // The common case for a healthy repo - and the regression that motivated the
  // backend-computed set: tracked images/fonts/.ico/.gitignore are absent from
  // the extension-filtered scan but were never deleted, and used to be drawn as
  // deletions on the commit that added them.
  const scan: ScanResult = {
    root: 'C:\\repo',
    nodes: [dir('C:\\repo'), file('C:\\repo\\app\\page.tsx', '.tsx')],
    links: [],
  };
  const { ghostNodes, ghostLinks } = buildGhostGraphData(scan, []);
  assert.deepEqual(ghostNodes, []);
  assert.deepEqual(ghostLinks, []);
});

test('buildGhostGraphData walks up to the nearest existing ancestor directory', () => {
  const scan: ScanResult = {
    root: 'C:\\repo',
    nodes: [dir('C:\\repo'), dir('C:\\repo\\src')], // no src/old dir
    links: [],
  };
  const { ghostLinks } = buildGhostGraphData(scan, ['src/old/deleted.ts']);
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
  const { ghostNodes, ghostLinks } = buildGhostGraphData(scan, [
    'src/old/deleted.ts', // nested, no ancestor -> root
    'Makefile', // no slash at all -> root
  ]);
  assert.equal(ghostNodes.length, 2);
  const bySource = new Map(ghostLinks.map((l) => [l.target, l.source]));
  assert.equal(bySource.get(`${GHOST_PREFIX}src/old/deleted.ts`), 'C:\\repo');
  assert.equal(bySource.get(`${GHOST_PREFIX}Makefile`), 'C:\\repo');
  // A file with no extension yields an empty ext.
  const topLevel = ghostNodes.find((n) => n.path === 'Makefile')!;
  assert.equal(topLevel.ext, '');
});
