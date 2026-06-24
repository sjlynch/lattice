// A tree-aware, O(N) local repulsion force — a drop-in replacement for d3's
// `forceManyBody` ('charge') in the file-graph layout.
//
// WHY. The file graph is a containment *tree* rendered in `td` DAG mode, so
// every node's Y is pinned by depth (`fy`) and only the X/Z plane is free.
// Benchmarking the live layout showed `forceManyBody` (global Barnes-Hut octree)
// is ~100% of the per-tick layout CPU — and it is overkill for a tree: all we
// actually need is for nearby nodes to push apart so sibling subtrees don't
// overlap. Global all-to-all repulsion across distant, unrelated subtrees buys
// almost nothing visible but pays O(N log N) every tick (the "graph eats ~60%
// CPU while updating" symptom).
//
// WHAT. A linked-cell spatial grid (one-level Barnes-Hut): each node repels only
// the nodes in its own grid cell and the 8 neighbours, in the X/Z plane only.
// Cell size == interaction radius, so the cost is O(N) for the near-uniform
// density a source tree settles into, with no octree to build or recurse. The
// force law mirrors `forceManyBody`'s effective `~strength/dist` acceleration so
// the existing "Repulsion (charge)" slider keeps its feel. Y is left untouched
// (it's pinned by `fy` in `td` mode, so a Y impulse would be discarded anyway).
//
// The grid pattern mirrors `labelPhysics/spatialGrid.ts` (integer-packed cell
// keys, pooled buckets) so the hot per-tick loop allocates nothing steady-state.

// d3-force-3d sim node: positions/velocities live directly on the node object.
type SimNode = {
  x?: number;
  z?: number;
  vx?: number;
  vz?: number;
};

// Pack an integer (cx, cz) cell coordinate into a single Map key — same scheme
// (and collision-free range) as labelPhysics/spatialGrid.ts.
const CELL_KEY_BIAS = 2_000_000;
const CELL_KEY_STRIDE = 4_000_000;

// Clamp the squared separation so coincident / near-coincident nodes (e.g. new
// children seeded onto their parent's exact position) get a strong but finite
// kick instead of an infinite one. velocityDecay damps the rest.
const MIN_DIST2 = 1;

export type LocalRepulsionForce = {
  (alpha: number): void;
  initialize(nodes: SimNode[]): void;
  /** d3 charge convention: negative strength = repel. */
  strength(): number;
  strength(value: number): LocalRepulsionForce;
  /** Grid cell edge == interaction radius (world units). */
  cellSize(): number;
  cellSize(value: number): LocalRepulsionForce;
};

export function forceLocalRepulsion(): LocalRepulsionForce {
  let nodes: SimNode[] = [];
  let strength = -30;
  let cellSize = 60;

  // Per-tick scratch, reused across ticks. Cell coords stashed in the build
  // pass and reused in the pairwise pass (no second floor/divide).
  let cellX = new Int32Array(0);
  let cellZ = new Int32Array(0);
  const grid = new Map<number, number[]>();
  // Bucket pool so the grid rebuild allocates no arrays in steady state.
  const pool: number[][] = [];
  const active: number[][] = [];

  function ensureCapacity(n: number) {
    if (cellX.length < n) {
      cellX = new Int32Array(n);
      cellZ = new Int32Array(n);
    }
  }

  function resetGrid() {
    for (let i = 0; i < active.length; i++) {
      active[i].length = 0;
      pool.push(active[i]);
    }
    active.length = 0;
    grid.clear();
  }

  function takeBucket(): number[] {
    const b = pool.pop() ?? [];
    active.push(b);
    return b;
  }

  const force = ((alpha: number) => {
    const count = nodes.length;
    if (count === 0 || strength === 0) return;
    ensureCapacity(count);
    resetGrid();

    const inv = 1 / cellSize;
    for (let i = 0; i < count; i++) {
      const n = nodes[i];
      const cx = Math.floor((n.x ?? 0) * inv);
      const cz = Math.floor((n.z ?? 0) * inv);
      cellX[i] = cx;
      cellZ[i] = cz;
      const key = (cx + CELL_KEY_BIAS) * CELL_KEY_STRIDE + (cz + CELL_KEY_BIAS);
      let bucket = grid.get(key);
      if (!bucket) {
        bucket = takeBucket();
        grid.set(key, bucket);
      }
      bucket.push(i);
    }

    // k > 0 = outward push (d3 charge uses negative strength for repulsion).
    const k = -strength;
    const range2 = cellSize * cellSize;
    for (let i = 0; i < count; i++) {
      const ni = nodes[i];
      const xi = ni.x ?? 0;
      const zi = ni.z ?? 0;
      const cx = cellX[i];
      const cz = cellZ[i];
      let vxi = ni.vx ?? 0;
      let vzi = ni.vz ?? 0;
      for (let dx = -1; dx <= 1; dx++) {
        const rowBase = (cx + dx + CELL_KEY_BIAS) * CELL_KEY_STRIDE;
        for (let dz = -1; dz <= 1; dz++) {
          const bucket = grid.get(rowBase + (cz + dz + CELL_KEY_BIAS));
          if (!bucket) continue;
          for (let bi = 0; bi < bucket.length; bi++) {
            const j = bucket[bi];
            if (j <= i) continue; // each pair once
            const nj = nodes[j];
            let xd = xi - (nj.x ?? 0);
            let zd = zi - (nj.z ?? 0);
            let d2 = xd * xd + zd * zd;
            if (d2 > range2) continue;
            if (d2 < MIN_DIST2) {
              // Deterministic tiny offset for (near-)coincident nodes so the
              // pair separates without a random, replay-unstable jitter.
              xd = ((i % 7) - 3) * 0.5 + 0.13;
              zd = ((j % 5) - 2) * 0.5 + 0.11;
              d2 = xd * xd + zd * zd;
            }
            // w applied to the (xd, zd) delta of length dist gives a net
            // ~k*alpha/dist acceleration — the same falloff as forceManyBody.
            const w = (k * alpha) / d2;
            const fxw = xd * w;
            const fzw = zd * w;
            vxi += fxw;
            vzi += fzw;
            nj.vx = (nj.vx ?? 0) - fxw;
            nj.vz = (nj.vz ?? 0) - fzw;
          }
        }
      }
      ni.vx = vxi;
      ni.vz = vzi;
    }
  }) as LocalRepulsionForce;

  force.initialize = (n: SimNode[]) => {
    nodes = n;
  };
  force.strength = ((value?: number) => {
    if (value === undefined) return strength;
    strength = value;
    return force;
  }) as LocalRepulsionForce['strength'];
  force.cellSize = ((value?: number) => {
    if (value === undefined) return cellSize;
    cellSize = Math.max(1, value);
    return force;
  }) as LocalRepulsionForce['cellSize'];

  return force;
}
