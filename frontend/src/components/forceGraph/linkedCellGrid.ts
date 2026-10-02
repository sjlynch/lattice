// Linked-cell spatial grid over the X/Z plane — the shared O(N·k) neighbour
// search behind the graph's pairwise passes: `localRepulsionForce` (charge),
// `layoutShapeForces` (`forceCollideXZ`) and the floating-label repulsion
// (`labelPhysics/spatialGrid.ts`). Each point is bucketed by its integer cell;
// its candidate partners are the points in its own cell and the 8 around it, so
// with cell edge >= interaction radius every in-range pair is a candidate.
// Callers compute the cell coordinates (keeping their own rounding bit-for-bit)
// and own the pair math; this module owns only the bucketing and iteration.
//
// Hot-path contract — these passes run every simulation tick / label frame:
// - Zero steady-state allocation: the cell-coordinate scratch and the bucket
//   arrays are reused across rebuilds (buckets recycle through a pool).
// - No per-tick closures: iteration is a cursor (`visitNeighbors(i)`, then
//   `nextNeighbor()` until it returns -1) rather than a callback.
// - Deterministic order: each unordered pair is yielded exactly once, from the
//   lower index's side (j > i); neighbour cells in dx-major / dz-minor order
//   from (-1, -1) to (+1, +1); each bucket in insertion order. Callers
//   accumulate floats in this order, so it must not change or layouts stop
//   replaying identically.

// Pack an integer (cx, cz) cell coordinate into a single Map key, so the hot
// loop allocates no per-cell key strings. cx/cz are `floor(world / cellSize)`;
// at Lattice's world scale (graph spans a few thousand units) they stay within
// a few thousand of the origin. BIAS shifts them non-negative and STRIDE must
// exceed the largest possible `cz + BIAS`; with BIAS = 2e6 and STRIDE = 4e6 the
// key is unique for any cell coordinate in [-2e6, 2e6) (key max ≈ 4e6·4e6 =
// 1.6e13, far under Number.MAX_SAFE_INTEGER ≈ 9e15) — orders of magnitude
// beyond any real graph. The key is an opaque per-cell bucket identity.
const CELL_KEY_BIAS = 2_000_000;
const CELL_KEY_STRIDE = 4_000_000;

// The 3×3 neighbourhood, dx-major / dz-minor (see the order contract above).
const NEIGHBOR_DX = [-1, -1, -1, 0, 0, 0, 1, 1, 1] as const;
const NEIGHBOR_DZ = [-1, 0, 1, -1, 0, 1, -1, 0, 1] as const;
const NEIGHBOR_CELLS = 9;

export class LinkedCellGrid {
  // Integer cell coords per point, written by `insert` and reused by
  // `visitNeighbors` so no second floor/divide is needed.
  private cellX = new Int32Array(0);
  private cellZ = new Int32Array(0);
  private readonly cells = new Map<number, number[]>();
  // Bucket pool so a rebuild allocates no arrays in steady state.
  private readonly pool: number[][] = [];
  private readonly active: number[][] = [];

  // Neighbour cursor (one at a time; `reset` invalidates it).
  private curI = 0;
  private curCx = 0;
  private curCz = 0;
  private curCell = NEIGHBOR_CELLS;
  private curBucket: number[] | undefined = undefined;
  private curPos = 0;

  /** Start a rebuild for points `0..count-1`: recycle every bucket and grow
   *  the cell scratch if needed. */
  reset(count: number): void {
    if (this.cellX.length < count) {
      const capacity = Math.max(64, count * 2);
      this.cellX = new Int32Array(capacity);
      this.cellZ = new Int32Array(capacity);
    }
    const active = this.active;
    for (let b = 0; b < active.length; b++) {
      active[b].length = 0;
      this.pool.push(active[b]);
    }
    active.length = 0;
    this.cells.clear();
    this.curCell = NEIGHBOR_CELLS;
    this.curBucket = undefined;
  }

  /** Bucket point `i` (< the `reset` count) into integer cell `(cx, cz)`.
   *  Insert in ascending `i` — bucket order is insertion order. */
  insert(i: number, cx: number, cz: number): void {
    this.cellX[i] = cx;
    this.cellZ[i] = cz;
    const key = (cx + CELL_KEY_BIAS) * CELL_KEY_STRIDE + (cz + CELL_KEY_BIAS);
    let bucket = this.cells.get(key);
    if (bucket === undefined) {
      bucket = this.pool.pop() ?? [];
      this.active.push(bucket);
      this.cells.set(key, bucket);
    }
    bucket.push(i);
  }

  /** Point the cursor at point `i`'s 3×3 cell neighbourhood. */
  visitNeighbors(i: number): void {
    this.curI = i;
    this.curCx = this.cellX[i];
    this.curCz = this.cellZ[i];
    this.curCell = 0;
    this.curBucket = undefined;
    this.curPos = 0;
  }

  /** Next candidate partner `j > i` of the visited point, or -1 when done. */
  nextNeighbor(): number {
    const i = this.curI;
    let bucket = this.curBucket;
    let pos = this.curPos;
    for (;;) {
      if (bucket !== undefined) {
        while (pos < bucket.length) {
          const j = bucket[pos++];
          if (j > i) {
            // Each unordered pair once, from the lower index's side.
            this.curBucket = bucket;
            this.curPos = pos;
            return j;
          }
        }
      }
      if (this.curCell >= NEIGHBOR_CELLS) {
        this.curBucket = undefined;
        return -1;
      }
      const c = this.curCell++;
      bucket = this.cells.get(
        (this.curCx + NEIGHBOR_DX[c] + CELL_KEY_BIAS) * CELL_KEY_STRIDE +
          (this.curCz + NEIGHBOR_DZ[c] + CELL_KEY_BIAS),
      );
      pos = 0;
    }
  }
}
