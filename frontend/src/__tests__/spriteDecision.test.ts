import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { GraphNode } from '../api';
import type { NodeObjectRefs } from '../components/forceGraph/nodeObjectFactory.ts';
import {
  decideSpriteState,
  type SpriteDecision,
} from '../components/forceGraph/spriteDecision.ts';
import { GHOST_PREFIX } from '../components/forceGraph/timelineDiff.ts';

// `decideSpriteState` is the pure, THREE-free decision tree behind every node
// sprite: which base kind to draw (ghost / health > loc > dead > base), whether
// the base sprite hides under batched rendering, and whether the change ring,
// Alt label and selection halo attach. Table-driven so each precedence rule is
// one row — `buildNodeObject` is just the linear application of this result.

type Flags = Partial<{
  loc: boolean;
  health: boolean;
  dead: boolean;
  security: boolean;
  label: boolean;
  batched: boolean;
  selected: string[];
  ignoredExts: string[];
  changes: [string, 'added' | 'modified' | 'deleted'][];
  depths: [string, number][];
}>;

const ROOT = 'C:\\proj';

function refsFor(f: Flags): NodeObjectRefs {
  return {
    // Only `root` is read (for the change-ring relative path).
    settingsRef: { current: {} as NodeObjectRefs['settingsRef']['current'] },
    selectedRef: { current: new Set(f.selected ?? []) },
    dataRef: {
      current: { root: ROOT, nodes: [], links: [] } as unknown as NodeObjectRefs['dataRef']['current'],
    },
    locModeRef: { current: f.loc ?? false },
    healthModeRef: { current: f.health ?? false },
    deadModeRef: { current: f.dead ?? false },
    securityModeRef: { current: f.security ?? false },
    securityFilesRef: { current: null },
    labelModeRef: { current: f.label ?? false },
    labelShiftRef: { current: false },
    labelLevelRef: { current: 1 },
    nodeDepthsRef: { current: new Map(f.depths ?? []) },
    changeMapRef: { current: new Map(f.changes ?? []) },
    metricsIgnoredExtsRef: { current: new Set(f.ignoredExts ?? []) },
    batchedNodesRef: { current: f.batched ?? false },
    worktreeRingsRef: { current: null },
  };
}

const tsFile: GraphNode = {
  id: 'f1',
  name: 'a.ts',
  path: `${ROOT}\\src\\a.ts`,
  kind: 'file',
  ext: '.ts',
};
const jsonFile: GraphNode = {
  id: 'f2',
  name: 'x.json',
  path: `${ROOT}\\x.json`,
  kind: 'file',
  ext: '.json',
};
const dir: GraphNode = { id: 'd1', name: 'src', path: `${ROOT}\\src`, kind: 'dir' };
const ghost: GraphNode = {
  id: `${GHOST_PREFIX}src/gone.ts`,
  name: 'gone.ts',
  path: 'src/gone.ts',
  kind: 'file',
  ext: '.ts',
};

const NONE: SpriteDecision = {
  baseKind: 'base',
  hideBase: false,
  changeRingKind: null,
  showLabel: false,
  labelDepth: 0,
  selected: false,
};

const rows: { name: string; node: GraphNode; flags: Flags; want: SpriteDecision }[] = [
  {
    name: 'security overrides pinned metrics, suppresses rings/labels, and stays visible when batched',
    node: jsonFile,
    flags: { security: true, health: true, loc: true, dead: true, batched: true,
      label: true, ignoredExts: ['.json'], changes: [['x.json', 'modified']] },
    want: { ...NONE, baseKind: 'security' },
  },
  {
    name: 'plain file, no overlays → base sprite, nothing attached',
    node: tsFile,
    flags: {},
    want: NONE,
  },
  {
    name: 'ghost short-circuits everything (even under every overlay + batched)',
    node: ghost,
    flags: {
      loc: true,
      health: true,
      dead: true,
      label: true,
      batched: true,
      changes: [['src/gone.ts', 'deleted']],
      depths: [[ghost.id, 1]],
    },
    want: { ...NONE, baseKind: 'ghost' },
  },
  {
    name: 'ghost still reports selection (halo only)',
    node: ghost,
    flags: { selected: [ghost.id] },
    want: { ...NONE, baseKind: 'ghost', selected: true },
  },
  {
    name: 'health beats loc and dead',
    node: tsFile,
    flags: { health: true, loc: true, dead: true },
    want: { ...NONE, baseKind: 'health' },
  },
  {
    name: 'loc beats dead',
    node: tsFile,
    flags: { loc: true, dead: true },
    want: { ...NONE, baseKind: 'loc' },
  },
  {
    name: 'dead alone',
    node: tsFile,
    flags: { dead: true },
    want: { ...NONE, baseKind: 'dead' },
  },
  {
    name: 'metrics-ignored ext falls through health/loc to base',
    node: jsonFile,
    flags: { health: true, loc: true, ignoredExts: ['.json'] },
    want: NONE,
  },
  {
    name: 'metrics-ignored ext is NOT exempt from dead (reachability, not metrics)',
    node: jsonFile,
    flags: { health: true, loc: true, dead: true, ignoredExts: ['.json'] },
    want: { ...NONE, baseKind: 'dead' },
  },
  {
    name: 'ignore list is file-only: a dir under health keeps the health kind',
    node: dir,
    flags: { health: true, ignoredExts: ['.ts'] },
    want: { ...NONE, baseKind: 'health' },
  },
  {
    name: 'batched hides the base sprite in the base view',
    node: tsFile,
    flags: { batched: true },
    want: { ...NONE, hideBase: true },
  },
  {
    name: 'batched does NOT hide a recolor-overlay sprite',
    node: tsFile,
    flags: { batched: true, loc: true },
    want: { ...NONE, baseKind: 'loc' },
  },
  {
    name: 'batched + ignored ext under a metric view: the file draws its base sprite, but the view is still metric so the instanced mesh (not the sprite) hides',
    node: jsonFile,
    flags: { batched: true, health: true, ignoredExts: ['.json'] },
    want: NONE,
  },
  {
    name: 'change ring from the forward-relative path (added)',
    node: tsFile,
    flags: { changes: [['src/a.ts', 'added']] },
    want: { ...NONE, changeRingKind: 'added' },
  },
  {
    name: 'change ring (modified)',
    node: tsFile,
    flags: { changes: [['src/a.ts', 'modified']] },
    want: { ...NONE, changeRingKind: 'modified' },
  },
  {
    name: 'a deleted change never rings a live node',
    node: tsFile,
    flags: { changes: [['src/a.ts', 'deleted']] },
    want: NONE,
  },
  {
    name: 'dirs never get a change ring',
    node: dir,
    flags: { changes: [['src', 'added']] },
    want: NONE,
  },
  {
    name: 'Alt label with its depth band',
    node: tsFile,
    flags: { label: true, depths: [[tsFile.id, 2]] },
    want: { ...NONE, showLabel: true, labelDepth: 2 },
  },
  {
    name: 'Alt label defaults to depth 0 when the depth map has no entry',
    node: dir,
    flags: { label: true },
    want: { ...NONE, showLabel: true, labelDepth: 0 },
  },
  {
    name: 'a metric view (health) suppresses the change ring AND the label',
    node: tsFile,
    flags: { health: true, label: true, changes: [['src/a.ts', 'modified']], depths: [[tsFile.id, 2]] },
    want: { ...NONE, baseKind: 'health' },
  },
  {
    name: 'a metric view (loc) suppresses the change ring AND the label',
    node: tsFile,
    flags: { loc: true, label: true, changes: [['src/a.ts', 'added']] },
    want: { ...NONE, baseKind: 'loc' },
  },
  {
    name: 'a metric view (dead) suppresses the change ring AND the label',
    node: tsFile,
    flags: { dead: true, label: true, changes: [['src/a.ts', 'added']] },
    want: { ...NONE, baseKind: 'dead' },
  },
  {
    name: 'a metric view suppresses ring + label even for an ignored-ext file drawn as base',
    node: jsonFile,
    flags: { health: true, label: true, ignoredExts: ['.json'], changes: [['x.json', 'modified']] },
    want: NONE,
  },
  {
    name: 'selected file: halo alongside ring + label',
    node: tsFile,
    flags: { selected: [tsFile.id], label: true, changes: [['src/a.ts', 'added']], depths: [[tsFile.id, 2]] },
    want: { ...NONE, changeRingKind: 'added', showLabel: true, labelDepth: 2, selected: true },
  },
];

for (const row of rows) {
  test(`decideSpriteState: ${row.name}`, () => {
    assert.deepEqual(decideSpriteState(row.node, refsFor(row.flags)), row.want);
  });
}
