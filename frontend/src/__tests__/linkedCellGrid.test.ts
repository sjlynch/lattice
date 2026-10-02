import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LinkedCellGrid } from '../components/forceGraph/linkedCellGrid.ts';

type Pt = { x: number; z: number };
type Cell = readonly [number, number];

// Seeded PRNG (mulberry32) so every run sees the same point clouds.
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Points centred on the origin (so negative cells are exercised); every 9th
// point copies an earlier one, giving coincident pairs that share a bucket.
function randomCloud(seed: number, count: number, span: number): Pt[] {
  const next = rng(seed);
  const pts: Pt[] = [];
  for (let i = 0; i < count; i++) {
    if (i > 0 && i % 9 === 0) {
      const src = pts[Math.floor(next() * i)];
      pts.push({ x: src.x, z: src.z });
    } else {
      pts.push({ x: (next() - 0.5) * span, z: (next() - 0.5) * span });
    }
  }
  return pts;
}

// Cell coords the way the forces compute them (cell edge == radius).
function cellsOf(pts: readonly Pt[], cellSize: number): Cell[] {
  const inv = 1 / cellSize;
  return pts.map((p): Cell => [Math.floor(p.x * inv), Math.floor(p.z * inv)]);
}

function build(grid: LinkedCellGrid, cells: readonly Cell[]): void {
  grid.reset(cells.length);
  for (let i = 0; i < cells.length; i++) grid.insert(i, cells[i][0], cells[i][1]);
}

// Every (i, j) the cursor yields, in visit order.
function visitAll(grid: LinkedCellGrid, count: number): Array<[number, number]> {
  const pairs: Array<[number, number]> = [];
  for (let i = 0; i < count; i++) {
    grid.visitNeighbors(i);
    for (let j = grid.nextNeighbor(); j >= 0; j = grid.nextNeighbor()) {
      pairs.push([i, j]);
    }
  }
  return pairs;
}

function within(a: Pt, b: Pt, radius2: number): boolean {
  const dx = a.x - b.x;
  const dz = a.z - b.z;
  return dx * dx + dz * dz <= radius2;
}

// The grid's candidates narrowed to the in-range ones, as sorted "i,j" keys.
function gridPairsWithin(grid: LinkedCellGrid, pts: readonly Pt[], radius: number): string[] {
  const r2 = radius * radius;
  return visitAll(grid, pts.length)
    .filter(([i, j]) => within(pts[i], pts[j], r2))
    .map(([i, j]) => `${i},${j}`)
    .sort();
}

// O(n²) reference: every unordered pair within `radius`, as sorted "i,j" keys.
function bruteForcePairs(pts: readonly Pt[], radius: number): string[] {
  const r2 = radius * radius;
  const out: string[] = [];
  for (let i = 0; i < pts.length; i++) {
    for (let j = i + 1; j < pts.length; j++) {
      if (within(pts[i], pts[j], r2)) out.push(`${i},${j}`);
    }
  }
  return out.sort();
}

// The sweep the forces ran before the grid was extracted: for each i, the 3×3
// cells dx-major / dz-minor, each bucket in insertion order, keeping j > i.
function referenceSweep(cells: readonly Cell[]): Array<[number, number]> {
  const buckets = new Map<string, number[]>();
  cells.forEach(([cx, cz], i) => {
    const key = `${cx},${cz}`;
    const bucket = buckets.get(key);
    if (bucket) bucket.push(i);
    else buckets.set(key, [i]);
  });
  const pairs: Array<[number, number]> = [];
  for (let i = 0; i < cells.length; i++) {
    const [cx, cz] = cells[i];
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        for (const j of buckets.get(`${cx + dx},${cz + dz}`) ?? []) {
          if (j > i) pairs.push([i, j]);
        }
      }
    }
  }
  return pairs;
}

test('visits exactly the within-radius pairs a brute-force O(n²) check finds', () => {
  // One grid across every cloud, so recycled buckets (growing and shrinking
  // point counts) are covered too.
  const grid = new LinkedCellGrid();
  const cases = [
    { seed: 1, count: 0, span: 100, radius: 10 },
    { seed: 2, count: 1, span: 100, radius: 10 },
    { seed: 3, count: 2, span: 5, radius: 10 },
    { seed: 4, count: 400, span: 600, radius: 30 }, // sparse
    { seed: 5, count: 300, span: 80, radius: 20 }, // dense: many per cell
    { seed: 6, count: 250, span: 2000, radius: 60 },
    { seed: 7, count: 40, span: 300, radius: 7.5 }, // shrink after growth
  ];
  for (const c of cases) {
    const pts = randomCloud(c.seed, c.count, c.span);
    build(grid, cellsOf(pts, c.radius));

    const visited = visitAll(grid, pts.length);
    const keys = visited.map(([i, j]) => `${i},${j}`);
    assert.equal(new Set(keys).size, keys.length, `seed ${c.seed}: no pair visited twice`);
    for (const [i, j] of visited) {
      assert.ok(j > i, `seed ${c.seed}: (${i}, ${j}) yielded from the lower index`);
    }

    const expected = bruteForcePairs(pts, c.radius);
    if (c.count >= 10) assert.ok(expected.length > 0, `seed ${c.seed}: cloud has in-range pairs`);
    assert.deepEqual(gridPairsWithin(grid, pts, c.radius), expected, `seed ${c.seed}`);
  }
});

test('visit order is the 3×3 dx-major / dz-minor sweep over insertion-ordered buckets', () => {
  const pts = randomCloud(11, 300, 400);
  const cells = cellsOf(pts, 25);
  const grid = new LinkedCellGrid();
  build(grid, cells);
  assert.deepEqual(visitAll(grid, pts.length), referenceSweep(cells));
});

test('pairs exactly one radius apart across a cell boundary are visited', () => {
  // cellSize 8 has an exact reciprocal: on a 5×5 lattice with spacing 8 every
  // axis neighbour sits exactly `radius` away, in the adjacent cell.
  const pts: Pt[] = [];
  for (let gx = -2; gx <= 2; gx++) {
    for (let gz = -2; gz <= 2; gz++) pts.push({ x: gx * 8, z: gz * 8 });
  }
  const grid = new LinkedCellGrid();
  build(grid, cellsOf(pts, 8));
  const expected = bruteForcePairs(pts, 8);
  assert.equal(expected.length, 40, '20 row + 20 column neighbours');
  assert.deepEqual(gridPairsWithin(grid, pts, 8), expected);
});

test('the cursor stays exhausted and a rebuild invalidates it', () => {
  const grid = new LinkedCellGrid();
  assert.equal(grid.nextNeighbor(), -1, 'no cursor before any visit');
  build(grid, [[0, 0], [0, 0]]);
  grid.visitNeighbors(0);
  assert.equal(grid.nextNeighbor(), 1);
  assert.equal(grid.nextNeighbor(), -1);
  assert.equal(grid.nextNeighbor(), -1, 'stays exhausted');
  grid.visitNeighbors(0);
  build(grid, [[0, 0], [0, 0]]);
  assert.equal(grid.nextNeighbor(), -1, 'reset drops a half-walked cursor');
});
