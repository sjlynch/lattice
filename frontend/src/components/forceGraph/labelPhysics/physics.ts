// Physics tuning constants for the floating-label repulsion step. These
// are the only knobs governing the home-spring pull, pairwise push, and
// rest detection — kept together so the behaviour can be read and tuned
// without scrolling through the grid build or integration loop.

// Spring constant pulling each label back toward (0, _, 0) in its
// parent's local frame. Lower → labels can drift further before being
// pulled in. We keep this gentle so neighbour repulsion can dominate
// when nodes are clustered.
export const HOME_K = 0.04;
// Force scaling for pairwise repulsion. Multiplied by the overlap
// fraction (MIN_DIST - d) / MIN_DIST so the push smoothly tapers off
// to zero exactly when the labels are at the requested separation.
export const PUSH_K = 0.6;
// Velocity retention per frame. Lower = stronger damping = settles
// faster. 0.5 kills most overshoot within a handful of frames.
export const FRICTION = 0.5;
// Velocities / residual forces below these magnitudes snap to rest so
// labels stop entirely instead of drifting at sub-pixel rates.
export const REST_VEL = 0.02;
export const REST_FORCE = 0.015;
// Pre-squared rest thresholds: `Math.hypot(a, b) < REST_*` is equivalent to
// `a*a + b*b < REST_*_SQ` (both sides non-negative) and lets the hot
// integration loop skip the per-call `Math.hypot` (slow in V8, runs twice
// per label per frame). Computed once here so nothing recomputes them.
export const REST_VEL_SQ = REST_VEL * REST_VEL;
export const REST_FORCE_SQ = REST_FORCE * REST_FORCE;
export const REST_FRAMES = 6;
export const LINE_EPS = 0.001;
export const ZERO_DISTANCE_EPS = 1e-4;
export const ZERO_DISTANCE_JITTER = 0.01;
