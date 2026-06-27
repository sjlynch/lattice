// Pure radial tidy-tree layout for the file graph (`hooks/useRadialTidyLayout`):
// the on-load untangler. The scan is a containment *tree* (every file/dir has
// exactly one parent — its directory), so we can lay it out as a radial tidy
// tree: each subtree is given its own angular wedge (sized by how many leaves it
// contains), and radius grows with directory depth. Because sibling subtrees
// never share an angular wedge, their links can't cross — the seed is
// effectively planar (0 link crossings) instead of the phyllotaxis-spiral seed
// the library uses, which ignores the tree and tangles subtrees together.
//
// The physics engine then settles *from* this seed: the wedges are preserved
// (the forces are radially symmetric, so they expand/relax subtrees outward
// without rotating them past each other) while the global charge declumps the
// per-directory file clusters into 2D area. See `hooks/useRadialTidyLayout`.
//
// Kept dependency-light (types only) so it unit-tests without pulling in THREE.

import type { ScanResult, GraphLink } from '../../api';

export type TidyLayoutOptions = {
  // User "Radial spread" multiplier on the computed ring spacing (1 = the
  // auto-tuned value). Larger = a wider seed.
  spread: number;
  // The active physics link distance + DAG level distance. Used to scale the
  // seed so it lands at ~half the force-directed natural radius (see ringStep).
  linkDistance: number;
  dagLevelDistance: number;
};

// Per-node X/Z target. Y is left alone — the graph runs in `td` DAG mode, so
// every node's Y is pinned by depth (`fy`).
export type TidyPositions = Map<string, { x: number; z: number }>;

function linkEnd(end: GraphLink['source']): string {
  // Pure ScanResult links carry string ids; a live d3 sim resolves them to node
  // objects. Handle both so the same helper works on either.
  return typeof end === 'object' && end !== null
    ? (end as { id: string }).id
    : (end as string);
}

// Build the containment tree (parent dir → children) from the scan links.
function buildTree(data: ScanResult): {
  children: Map<string, string[]>;
  roots: string[];
} {
  const ids = new Set(data.nodes.map((n) => n.id));
  const children = new Map<string, string[]>();
  const parent = new Map<string, string>();
  for (const l of data.links) {
    const s = linkEnd(l.source);
    const t = linkEnd(l.target);
    if (!ids.has(s) || !ids.has(t)) continue;
    let arr = children.get(s);
    if (!arr) {
      arr = [];
      children.set(s, arr);
    }
    arr.push(t);
    parent.set(t, s);
  }
  // Deterministic sibling order (by id) so the layout is stable across reloads.
  for (const arr of children.values()) arr.sort();
  const roots = data.nodes.map((n) => n.id).filter((id) => !parent.has(id));
  return { children, roots };
}

// Leaf count per subtree (a node with no children counts as 1). Drives the
// angular wedge sizes: each leaf gets an equal slice of its ancestors' wedges,
// so dense subtrees fan out proportionally wider. `seen` guards against a
// malformed non-tree input (cycle / shared child) looping forever.
function leafWeights(
  roots: string[],
  children: Map<string, string[]>,
): Map<string, number> {
  const weight = new Map<string, number>();
  const seen = new Set<string>();
  const post = (id: string): number => {
    const cached = weight.get(id);
    if (cached !== undefined) return cached;
    if (seen.has(id)) return 1;
    seen.add(id);
    const ch = children.get(id);
    if (!ch || ch.length === 0) {
      weight.set(id, 1);
      return 1;
    }
    let w = 0;
    for (const c of ch) w += post(c);
    weight.set(id, w);
    return w;
  };
  for (const r of roots) post(r);
  return weight;
}

// Deepest directory-nesting level reached from any root (root = depth 0).
function treeDepth(
  roots: string[],
  children: Map<string, string[]>,
): number {
  let max = 0;
  const seen = new Set<string>();
  const rec = (id: string, d: number) => {
    if (seen.has(id)) return;
    seen.add(id);
    if (d > max) max = d;
    const ch = children.get(id);
    if (ch) for (const c of ch) rec(c, d + 1);
  };
  for (const r of roots) rec(r, 0);
  return max;
}

// Radial spacing between depth rings. A force-directed graph settles to a radius
// on the order of `sqrt(N) * linkDistance` (it spreads to fill an area ∝ N); we
// seed at ~half that (the 0.5) so the engine relaxes *outward* from the seed —
// the outward expansion is what declumps each directory's file cluster into 2D
// area while leaving the angular wedges intact. (A seed wider than the natural
// radius makes the engine contract instead, freezing the clumps.) Floored at the
// DAG level distance so rings are never closer than the vertical level spacing.
export function tidyRingStep(
  nodeCount: number,
  maxDepth: number,
  opts: TidyLayoutOptions,
): number {
  const spread = opts.spread > 0 ? opts.spread : 1;
  const auto =
    (spread * 0.5 * Math.sqrt(Math.max(1, nodeCount)) * opts.linkDistance) /
    Math.max(1, maxDepth);
  return Math.max(opts.dagLevelDistance, auto);
}

// Compute the radial tidy-tree X/Z target for every node. Empty/last-resort
// inputs yield an empty map (the caller then leaves the library seed alone).
export function computeRadialTidyLayout(
  data: ScanResult | null,
  opts: TidyLayoutOptions,
): TidyPositions {
  const out: TidyPositions = new Map();
  if (!data || data.nodes.length === 0) return out;

  const { children, roots } = buildTree(data);
  if (roots.length === 0) return out; // every node in a cycle — bail, don't loop

  const weight = leafWeights(roots, children);
  const maxDepth = treeDepth(roots, children);
  const ringStep = tidyRingStep(data.nodes.length, maxDepth, opts);

  const seen = new Set<string>();
  const place = (id: string, a0: number, a1: number, depth: number) => {
    if (seen.has(id)) return;
    seen.add(id);
    const angle = (a0 + a1) / 2;
    const radius = depth * ringStep;
    out.set(id, { x: radius * Math.cos(angle), z: radius * Math.sin(angle) });
    const ch = children.get(id);
    if (!ch || ch.length === 0) return;
    const w = weight.get(id) || 1;
    const span = a1 - a0;
    let a = a0;
    for (const c of ch) {
      const cw = weight.get(c) || 1;
      const next = a + (span * cw) / w;
      place(c, a, next, depth + 1);
      a = next;
    }
  };

  // Split the full circle among the roots by weight (normally a single scan
  // root, which gets the whole circle and sits at the origin).
  const totalW = roots.reduce((s, r) => s + (weight.get(r) || 1), 0) || 1;
  let a = 0;
  for (const r of roots) {
    const w = weight.get(r) || 1;
    const next = a + 2 * Math.PI * (w / totalW);
    place(r, a, next, 0);
    a = next;
  }
  return out;
}
