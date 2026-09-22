// Tunables + render-order constants shared across the Claude-agent overlay
// (see agentOverlay.ts). Centralised here so the beam, label, hover, and
// placement helpers all reference the same named values instead of inlining
// magic numbers.

import type { FloatingLabelSpriteConfig } from './floatingLabelSprite';
import type { LabelTextureOptions } from './labelTexture';

// How long a *non-current* touched file stays beamed after it stops being the
// agent's current file. The current (last-touched) file's beam never expires —
// it persists until a new file is touched or the session stops.
export const BEAM_TTL_MS = 2600;
// After a PostToolUse (tool finished), collapse the remaining TTL to this so
// the beam fades promptly but not instantly.
export const BEAM_END_FADE_MS = 700;
// Final fade ramp duration (opacity → 0 over the last stretch of the TTL).
export const FADE_MS = 700;
export const BEAM_MAX_OPACITY = 0.85;
// Endpoint movement (graph units) below which a beam's geometry is NOT re-
// uploaded to the GPU (Part B). Sub-pixel at any sane zoom, so a persistent beam
// over stationary file nodes stops re-uploading unchanged geometry every frame
// while the opacity/fade update still runs.
export const BEAM_MOVE_EPS = 0.01;
// Per-frame easing of the node toward its target (0..1; higher = snappier).
export const EASE = 0.12;
// Even slower easing for the height, so the hover line stays steady.
export const HOVER_EASE = 0.06;
// Rest threshold (graph units). When a node's / hover line's per-frame easing
// step moves it less than this, it's treated as "at rest" and stops requesting
// frames. Sub-pixel at any sane zoom, so the settle is visually imperceptible —
// it just lets the render loop idle instead of easing forever (see the
// AgentOverlay.tick "moving" return + idleController's `agents` reason).
export const REST_EPS = 0.5;
// The graph bounds (used for the hover-line height) are an O(N) scan over every
// file node, so the overlay caches them and recomputes immediately on engine-hot
// frames. As a cheap safety net against position changes that don't flip the
// idle controller's engine flag (e.g. a node drag reheats d3 directly), it also
// forces a recompute at least every this-many frames — capping staleness to
// ~half a second without paying the scan every frame.
export const BOUNDS_RECHECK_FRAMES = 30;
// The above-graph hover line sits this fraction of the graph's vertical
// extent above its top, clamped so it's neither glued to the graph nor lost
// in space on a very tall/short tree.
export const HOVER_MARGIN_FRACTION = 0.1;
export const HOVER_MARGIN_MIN = 25;
export const HOVER_MARGIN_MAX = 220;
export const GOLDEN_ANGLE = 137.508 * (Math.PI / 180);

// Render orders for the agent scene objects. The node body lives at 13; the
// group, beams, and label sit relative to it.
export const AGENT_GROUP_RENDER_ORDER = 9;
export const BEAM_RENDER_ORDER = 9;
export const LABEL_RENDER_ORDER = 14; // above the node body (13)

// Sprite is drawn at this multiple of the configured nodeSize.
export const NODE_SCALE_MULTIPLIER = 1.7;

// File label offset from the node, in multiples of nodeSize (just to the right
// of and slightly above the node).
export const LABEL_OFFSET_X_FACTOR = 1.6;
export const LABEL_OFFSET_Y_FACTOR = 0.9;

// Parked-position spread geometry: a freshly-spawned agent with no activity
// sits this far out from the graph centroid, on a golden-angle spiral.
export const PARKED_BASE_RADIUS = 40;
export const PARKED_RADIUS_FRACTION = 0.6;
export const PARKED_RADIUS_PADDING = 20;

// --- Subagent satellites ---------------------------------------------------
// A satellite (a Task/Agent subagent) is a smaller node that hangs at a fixed
// offset around its parent Claude node and FOLLOWS it — it never orbits for
// effect (that would pin the render loop; see the APL idle contract). Drawn at
// this fraction of the parent node's on-screen size.
export const SATELLITE_SCALE = 0.6;
// Distance from the parent node to each satellite, in multiples of nodeSize.
// Satellites are spread around the parent on a golden-angle ring by slot.
export const SATELLITE_RING_RADIUS = 4.2;
// Satellites sit slightly BELOW the parent (toward the file graph) by this many
// nodeSizes, so the cluster reads as "parent up top, helpers reaching down".
export const SATELLITE_DROP_FACTOR = 1.1;
// The tether line (parent → satellite) is drawn at this constant opacity, well
// under a focus beam so it reads as structure, not activity.
export const SATELLITE_TETHER_OPACITY = 0.3;
// Satellite focus beams are slightly dimmer than the parent's so the parent's
// own current file still dominates. Multiplies BEAM_MAX_OPACITY.
export const SATELLITE_BEAM_OPACITY_FACTOR = 0.8;
// Safety net for a satellite whose SubagentStop never arrives (e.g. the
// terminal was hard-killed). SubagentStop is the primary removal signal; this
// only reaps a satellite that has gone quiet (no fading beam — its persistent
// current-file beam doesn't count) for this long. Generous so a long-thinking
// subagent is rarely reaped early; one that is comes back on its next tool use.
export const SATELLITE_IDLE_TTL_MS = 5 * 60 * 1000;
// Satellite type label offset from its node (multiples of the satellite size).
export const SATELLITE_LABEL_OFFSET_X_FACTOR = 1.3;
export const SATELLITE_LABEL_OFFSET_Y_FACTOR = -1.1;
// Satellite type labels read smaller than the parent's file label.
export const SATELLITE_LABEL_SCALE = 0.78;

// File label next to the node (camera-scaled, like the Alt-labels overlay).
export const LABEL_OPTIONS: LabelTextureOptions = {
  font: '600 44px -apple-system, "Segoe UI", Inter, Roboto, sans-serif',
  strokeWidth: 9,
  height: 72,
  padX: 18,
  minWidth: 72,
  maxEntries: 256,
};

// Floating-label sprite config: same base height + config as the Alt-label
// overlay so agent labels read at the same (small) scale as the file labels.
export const LABEL_SPRITE_CONFIG: FloatingLabelSpriteConfig = {
  heightMultiplier: 1.6,
  maxScale: 120,
  aspectFallback: 3,
};
