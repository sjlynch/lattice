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
// Per-frame easing of the node toward its target (0..1; higher = snappier).
export const EASE = 0.12;
// Even slower easing for the height, so the hover line stays steady.
export const HOVER_EASE = 0.06;
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
