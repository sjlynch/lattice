import { latticeStorageKeys, safeLocalStorageGetItem, safeLocalStorageSetItem } from '../../storage/latticeLocalStorage';

// User-tweakable graph render + physics settings, persisted per project.
// Sliders that drive these live in GraphSettingsPanel.

// Layout repulsion strategy.
//   'nbody' — d3 `forceManyBody` (global Barnes-Hut octree); the library
//             default. `chargeTheta` tunes its accuracy/cost.
//   'local' — an O(N) tree-aware grid repulsion (`localRepulsionForce.ts`):
//             dramatically cheaper per tick because the file graph is a
//             containment tree, so global n-body is overkill. **Now the
//             default** — measured dramatically cheaper with comparable layout
//             aesthetics.
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
  // spike. Flat 1px lines. Default-on. See `instancedLinks.ts` and
  // `plans/graph-perf-plan.md`.
  batchedLinks: boolean;
  // Draw the directory→file links at all. Off hides every link (both the
  // batched and per-link renderers) via `linkVisibility`, leaving just the node
  // shapes — on a very large codebase the web of lines hides the file-type
  // colors. Render-only: the links still drive the layout forces. Default on.
  showLinks: boolean;
  // Render the base node shapes via a handful of `THREE.InstancedMesh`es (one
  // per distinct style) instead of one Sprite-bearing Group per node. The other
  // half of the orbit-cost lever (links being the first half): collapses ~N
  // per-frame node draw calls to ~the number of distinct file types on screen.
  // The per-node sprite stays mounted-but-invisible as the hover/right-click
  // pick proxy, so picking + the halo/ring/label overlays are untouched; the
  // recolor overlays (health/loc/dead) fall back to the per-node sprite path.
  // Default-on. See `instancedNodes.ts`.
  batchedNodes: boolean;
  // Show the numeric value labels (+ their connector lines) on the LOC (`z`)
  // and code-health (`h`) recolor overlays. Off by default: in most projects
  // the labels overlap so heavily they obscure the very recolor they annotate,
  // and the tinted shape already conveys the band by color. When on, each
  // measured file node sprouts its connector + number again. Affects only the
  // metric overlays — the Alt name-label overlay is unrelated.
  metricLabels: boolean;
  // Show the per-subagent type label (e.g. 'Explore') next to each satellite
  // orb in the Agent Presence Layer. Off by default — the satellite orbs alone
  // already convey "this agent spawned N subagents", and the type labels add
  // visual clutter without much signal. The satellite orbs themselves are
  // always shown regardless; this only toggles their text labels.
  showSubagentLabels: boolean;
  // --- "Spread / layout shape" knobs (the settings panel's Spread tab) ---
  //
  // d3 simulation alpha-decay rate. Lower = the engine runs more ticks before
  // it freezes, so repulsion has longer to relax the graph into a wider, more
  // open layout; higher freezes sooner (tighter/clumpier). d3's default is
  // 0.0228; we default a touch lower (0.014) for more spread. Applied live via
  // `graph.d3AlphaDecay`; bounded by the cooldownTicks/cooldownTime/d3AlphaMin
  // set at init.
  alphaDecay: number;
  // Physics ticks the engine runs BEFORE the first render (and before each
  // reheat), so on page load the graph appears already settled/spread instead
  // of visibly animating outward from the seeded clump. 0 = render from frame 1;
  // we default to 15. High values briefly block the reheat while they run.
  warmupTicks: number;
  // Node-collision radius in the X/Z plane (world units). >0 installs
  // `forceCollideXZ`, which keeps any two nodes ≥ ~2× this apart for even,
  // non-overlapping spacing. 0 = off (no collision force).
  collideRadius: number;
  // --- Radial tidy-tree untangle (see hooks/useRadialTidyLayout) ---
  // On page load, seed the graph as a radial tidy tree (each subtree in its own
  // angular wedge, radius ∝ directory depth) so sibling subtrees don't tangle,
  // then let the physics settle from that seed. Unlike the other Spread knobs
  // this defaults ON — it's the fix for the "cord nest" load tangle. Turn off to
  // keep the library's raw phyllotaxis seed.
  tidyLayoutOnLoad: boolean;
  // Multiplier on the auto-computed radial ring spacing (the "Radial spread"
  // slider). 1 = the auto-tuned value (seed at ~half the force-directed natural
  // radius); higher seeds wider, lower tighter. See `radialTidyLayout.tidyRingStep`.
  tidySpread: number;
  // --- Selection-halo glow (Rendering tab) ---
  // The pulsing additive-white bloom drawn over selected nodes so they brighten
  // and stay visible in dense graphs (see halo.ts). `selectionGlowStrength` is
  // its peak opacity: 0 = no node brightening (just the pulsing ring), 1 = a
  // strong white flash. `selectionGlowScale` is the bloom radius as a multiple
  // of the node's size. Both live-tunable; applied via hooks/useSelectionGlowSettings.
  selectionGlowStrength: number;
  selectionGlowScale: number;
  // Renderer pixel-ratio cap ("Render scale"). The WebGL drawing buffer is sized
  // to `min(devicePixelRatio, pixelRatio)` — so values below the device ratio
  // render fewer pixels per frame (softer, but a large fill-rate saving). The big
  // lever for machines where the browser falls back to SOFTWARE rendering (no GPU
  // hardware acceleration — common on locked-down business laptops, RDP sessions,
  // or a blocklisted driver): every canvas pixel is rasterized/composited on the
  // CPU there, so halving the scale ≈ 4× cheaper frames. Default 1.5 preserves
  // the historical cap. Applied in `sceneSetup.ts`.
  pixelRatio: number;
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
  // Stronger repulsion + longer links than the library baseline (-30 / 30) for a
  // wider, more open layout that reads better with the radial untangle below.
  chargeStrength: -55,
  linkDistance: 50,
  velocityDecay: 0.4,
  // ~3× cheaper n-body than d3's 0.9 default, with negligible visual change —
  // a safe across-the-board win for the "graph updating eats CPU" symptom.
  // (Only applies in `repulsionMode: 'nbody'`; the default is now 'local'.)
  chargeTheta: 1.5,
  // O(N) tree-aware repulsion by default — much cheaper per tick than global
  // n-body on the containment-tree graph, with comparable spread.
  repulsionMode: 'local',
  linkWidth: 0.7,
  // Default-on: collapse the per-frame node/link draw calls to a handful so
  // orbiting a large graph stays cheap out of the box. Picking, halos, rings,
  // labels, and recolor overlays all still work via the mounted-but-invisible
  // per-node sprite (see nodeObjectFactory / instancedNodes).
  batchedLinks: true,
  batchedNodes: true,
  showLinks: true,
  // Off by default — the LOC/health overlays start as pure recolors. In most
  // projects the per-node value labels overlap too much to read; opt in via the
  // graph settings panel when a sparser view makes them useful.
  metricLabels: false,
  // Off by default — the satellite orbs already show subagent presence; the
  // type labels are extra clutter. Opt in via the graph settings panel.
  showSubagentLabels: false,
  // Spread/shape knobs. A slower-than-d3 alpha decay (0.014 vs 0.0228) lets the
  // engine run more ticks so it relaxes into a wider, more open layout, and a
  // short warmup pre-settles it so it appears spread on load instead of visibly
  // expanding. No collision by default. The radial tidy-tree untangle is ON by
  // default (it's the cord-nest fix) at the auto spread.
  alphaDecay: 0.014,
  warmupTicks: 15,
  collideRadius: 0,
  tidyLayoutOnLoad: true,
  tidySpread: 1,
  // Selection glow: a moderate bloom (0.5 peak opacity) at 1.5× node size —
  // clearly brightens selected nodes without washing them white.
  selectionGlowStrength: 0.5,
  selectionGlowScale: 1.5,
  pixelRatio: 1.5,
};

export function loadSettings(project: string): GraphSettings {
  if (!project) return { ...DEFAULT_SETTINGS };
  try {
    const raw = safeLocalStorageGetItem(latticeStorageKeys.graphSettings(project));
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<GraphSettings>;
    return { ...DEFAULT_SETTINGS, ...parsed };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(project: string, settings: GraphSettings): boolean {
  if (!project) return false;
  return safeLocalStorageSetItem(
    latticeStorageKeys.graphSettings(project),
    JSON.stringify(settings),
  );
}
