// Optional, user-tunable "layout shape" force for the file graph — the node-
// spacing knob behind the settings panel's Spread tab. Like
// `localRepulsionForce.ts`, it's hand-rolled (rather than pulled from
// d3-force-3d) and operates in the **X/Z plane only**: the graph runs in `td`
// DAG mode, so every node's Y is pinned by depth (`fy`) and a Y impulse would be
// discarded anyway. Off by default (the registering hook only installs it when
// its radius is non-zero), so it never affects a default layout.
//
// It honors the render-on-demand contract: every impulse is scaled by `alpha`,
// so as the simulation cools the force fades to zero and the idle controller
// can still settle the scene to 0 frames (see forceGraph/CLAUDE.md invariants).
//
// (The radial seed that opens the graph into wheel-spoke arms on load is now a
// one-shot position seed, not a force — see `radialTidyLayout.ts`.)

// d3-force-3d sim node: positions/velocities live directly on the node object.
type SimNode = {
  id?: string;
  x?: number;
  z?: number;
  vx?: number;
  vz?: number;
};

// ---------------------------------------------------------------------------
// Collision: keep any two nodes at least `2 * radius` apart in the X/Z plane,
// giving even, non-overlapping spacing. Uses the same O(N) linked-cell grid as
// `localRepulsionForce` (cell edge == interaction diameter, so the 3×3 cell
// neighborhood covers every possible overlap) so it stays cheap on large
// graphs. Only overlapping pairs get an impulse, so a separated layout settles.
// ---------------------------------------------------------------------------
const CELL_KEY_BIAS = 2_000_000;
const CELL_KEY_STRIDE = 4_000_000;
// Coincident nodes (new children seeded on their parent's exact position) get a
// deterministic separation rather than a div-by-zero / random replay-unstable
// jitter.
const MIN_DIST2 = 1;

export type CollideForceXZ = {
  (alpha: number): void;
  initialize(nodes: SimNode[]): void;
  radius(value: number): CollideForceXZ;
  strength(value: number): CollideForceXZ;
};

export function forceCollideXZ(): CollideForceXZ {
  let nodes: SimNode[] = [];
  let radius = 0;
  let strength = 0.7;

  let cellX = new Int32Array(0);
  let cellZ = new Int32Array(0);
  const grid = new Map<number, number[]>();
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
    if (count === 0 || radius <= 0 || strength <= 0) return;
    ensureCapacity(count);
    resetGrid();

    const diameter = 2 * radius;
    const diameter2 = diameter * diameter;
    const inv = 1 / diameter;
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
            if (d2 >= diameter2) continue; // not overlapping
            if (d2 < MIN_DIST2) {
              xd = ((i % 7) - 3) * 0.5 + 0.13;
              zd = ((j % 5) - 2) * 0.5 + 0.11;
              d2 = xd * xd + zd * zd;
            }
            const d = Math.sqrt(d2);
            // Split the overlap between the two nodes; scaled by alpha so the
            // force fades as the layout cools (keeps the scene settle-able).
            const push = ((diameter - d) / d) * strength * alpha * 0.5;
            const fxw = xd * push;
            const fzw = zd * push;
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
  }) as CollideForceXZ;

  force.initialize = (n: SimNode[]) => {
    nodes = n;
  };
  force.radius = (value: number) => {
    radius = Math.max(0, value);
    return force;
  };
  force.strength = (value: number) => {
    strength = value;
    return force;
  };
  return force;
}
