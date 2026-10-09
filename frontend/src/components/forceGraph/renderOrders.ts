// Shared z-layer render-order constants for the force-graph scene. Every sprite /
// ring / line renders with `depthTest: false`, so `renderOrder` is the SOLE
// arbiter of who sits on top, regardless of camera distance or scene-graph
// parentage.
//
// The full z-order, back (painted first) to front (painted last):
//
//   9   — agent group / focus beams   (AGENT_GROUP_RENDER_ORDER / BEAM_RENDER_ORDER)
//   10  — links                        LINK_RENDER_ORDER
//   11  — change rings / selection ring RING_RENDER_ORDER
//   12  — node bodies / metric+dead overlays / ghost disc / batched mesh  NODE_RENDER_ORDER
//   12.5— selection glow (pulsing bloom over selected nodes)  SELECTION_GLOW_RENDER_ORDER
//   13  — Claude agent nodes + satellites  CLAUDE_NODE_RENDER_ORDER
//   14  — agent file labels            (LABEL_RENDER_ORDER)
//   30  — worktree rings               WORKTREE_RING_RENDER_ORDER
//   999 — floating-label fallback      FLOATING_LABEL_RENDER_ORDER
//
// The parenthesized agent-overlay layers (9, 14) live in
// `agentOverlayConstants.ts` and are listed for context only — do not duplicate
// or re-import them here.

// three-forcegraph sets renderOrder = 10 on its per-link THREE.Line objects; the
// batched LineSegments (instancedLinks.ts) matches it so links always draw behind
// the depth-test-disabled node sprites either way.
export const LINK_RENDER_ORDER = 10;

// Change rings (timeline scrubber) and the selection halo. Below the node body
// (12) so the body paints over the inner disc, leaving only the colored outline.
export const RING_RENDER_ORDER = 11;

// Base node bodies plus the metric (H/Z) and dead-code (D) recolor overlays, the
// deleted-node ghost disc, and the batched-node InstancedMesh — all the same
// on-screen "node body" layer, just above the rings (11) and links (10).
export const NODE_RENDER_ORDER = 12;

// The selection glow: an additive white bloom drawn just OVER the node body
// (fractional, so it's unambiguously above NODE_RENDER_ORDER=12 yet still below
// the Claude agent node at 13) that pulses to brighten selected nodes. Paired
// with the selection ring at RING_RENDER_ORDER (11), which stays below the body.
export const SELECTION_GLOW_RENDER_ORDER = 12.5;

// The free-floating Claude agent node and its subagent satellites — above every
// file body (12) and ring (11) so the live agent is never occluded.
export const CLAUDE_NODE_RENDER_ORDER = 13;

// The `W` worktree-modified ring sits well above the pack (past the Claude node
// at 13) so it is unambiguously the topmost graph element while held; otherwise
// any overlapping sibling node body would obscure it.
export const WORKTREE_RING_RENDER_ORDER = 30;

// Default for camera-scaled floating labels (Alt name labels, LOC/health metric
// labels) when a `FloatingLabelSpriteConfig` doesn't override `renderOrder` —
// far above everything so a label is never hidden behind the node it annotates.
export const FLOATING_LABEL_RENDER_ORDER = 999;
