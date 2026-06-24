// User-tweakable graph render + physics settings, persisted per project.
// Sliders that drive these live in GraphSettingsPanel.

// Layout repulsion strategy.
//   'nbody' — d3 `forceManyBody` (global Barnes-Hut octree); the library
//             default. `chargeTheta` tunes its accuracy/cost.
//   'local' — an O(N) tree-aware grid repulsion (`localRepulsionForce.ts`):
//             dramatically cheaper per tick because the file graph is a
//             containment tree, so global n-body is overkill. Opt-in while the
//             layout aesthetics are evaluated; flip the default once happy.
export type RepulsionMode = 'nbody' | 'local';

export type GraphSettings = {
  fileNodeSize: number;
  dirNodeSize: number;
  labelSize: number;
  // Multiplier applied to the per-overlay minimum-separation distance
  // used by the LOC (`z`), labels (Alt), and health (`h`) overlays.
  // 1 = the historical hard-coded distance; >1 spreads labels further
  // apart so dense clusters are easier to read.
  labelSpread: number;
  dagLevelDistance: number;
  chargeStrength: number;
  linkDistance: number;
  velocityDecay: number;
  // Barnes-Hut accuracy for the n-body 'charge' force (`forceManyBody.theta`).
  // Higher = coarser octree approximation = cheaper per tick. d3's default is
  // 0.9; we default to 1.5 (~3× cheaper, measured) since exact node spacing
  // isn't critical for this view. Only affects `repulsionMode: 'nbody'`.
  chargeTheta: number;
  // Layout repulsion strategy (see RepulsionMode above).
  repulsionMode: RepulsionMode;
  // Link cylinder width. >0 renders lit tube meshes (one per link, with a
  // per-frame lookAt while the layout runs); 0 renders flat lines, which are
  // cheaper to update per frame. Visual-only. Ignored when `batchedLinks` is on
  // (batched links are always flat).
  linkWidth: number;
  // Render all links as a single batched `THREE.LineSegments` instead of one
  // `THREE.Line`/cylinder per link. Collapses E≈N per-frame draw calls to 1 —
  // the big lever for orbiting a settled graph (no physics) without the CPU
  // spike. Flat 1px lines; opt-in while the look is evaluated. See
  // `instancedLinks.ts` and `plans/graph-perf-plan.md`.
  batchedLinks: boolean;
  // Render the base node shapes via a handful of `THREE.InstancedMesh`es (one
  // per distinct style) instead of one Sprite-bearing Group per node. The other
  // half of the orbit-cost lever (links being the first half): collapses ~N
  // per-frame node draw calls to ~the number of distinct file types on screen.
  // The per-node sprite stays mounted-but-invisible as the hover/right-click
  // pick proxy, so picking + the halo/ring/label overlays are untouched; the
  // recolor overlays (health/loc/dead) fall back to the per-node sprite path.
  // Opt-in while the look is evaluated. See `instancedNodes.ts`.
  batchedNodes: boolean;
};

// Defaults: file/dir node sizes are 2× the historical baseline (5.5 / 7) so
// the graph reads more clearly out of the box. labelSpread defaults to 1.5
// so all three overlays start with noticeably more label breathing room.
export const DEFAULT_SETTINGS: GraphSettings = {
  fileNodeSize: 11,
  dirNodeSize: 14,
  labelSize: 3.0,
  labelSpread: 1.5,
  dagLevelDistance: 50,
  chargeStrength: -30,
  linkDistance: 30,
  velocityDecay: 0.4,
  // ~3× cheaper n-body than d3's 0.9 default, with negligible visual change —
  // a safe across-the-board win for the "graph updating eats CPU" symptom.
  chargeTheta: 1.5,
  repulsionMode: 'nbody',
  linkWidth: 0.7,
  batchedLinks: false,
  batchedNodes: false,
};

export function loadSettings(project: string): GraphSettings {
  if (!project) return { ...DEFAULT_SETTINGS };
  try {
    const raw = localStorage.getItem(`lattice.graphSettings.${project}`);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<GraphSettings>;
    return { ...DEFAULT_SETTINGS, ...parsed };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}
