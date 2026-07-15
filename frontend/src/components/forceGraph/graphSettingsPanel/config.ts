import type { GraphSettings, RepulsionMode } from '../graphSettings';

// Horizontal tabs replacing the old flat section dividers — one group of
// controls visible at a time so the panel can't grow taller than the viewport
// (paired with the body's max-height/overflow guard in graph.css).
export type TabKey = 'sizes' | 'physics' | 'spread' | 'rendering';
export const DEFAULT_TAB: TabKey = 'sizes';
export const TABS: { key: TabKey; label: string }[] = [
  { key: 'sizes', label: 'Sizes' },
  { key: 'physics', label: 'Physics' },
  { key: 'spread', label: 'Spread' },
  { key: 'rendering', label: 'Rendering' },
];

// Curried setter factory shared by the panel + row controls: bind a settings
// key, get back a value-taking setter that emits the updated GraphSettings.
// One of these replaces the panel's former ~8 near-identical spread setters.
export type SetField = <K extends keyof GraphSettings>(
  key: K,
) => (value: GraphSettings[K]) => void;

// SliderRow only drives the numeric settings; non-numeric settings (e.g.
// repulsionMode) get bespoke controls below.
export type NumericKey = {
  [K in keyof GraphSettings]: GraphSettings[K] extends number ? K : never;
}[keyof GraphSettings];

export type SliderRow = {
  key: NumericKey;
  label: string;
  min: number;
  max: number;
  step: number;
  format?: (v: number) => string;
};

export const NODE_ROWS: SliderRow[] = [
  { key: 'fileNodeSize', label: 'File node size', min: 2, max: 30, step: 0.5 },
  { key: 'dirNodeSize', label: 'Folder node size', min: 2, max: 30, step: 0.5 },
  { key: 'labelSize', label: 'Label size', min: 3, max: 24, step: 0.5 },
  {
    key: 'labelSpread',
    label: 'Label spread',
    min: 0.5,
    max: 25,
    step: 0.1,
    format: (v) => `${v.toFixed(1)}×`,
  },
];

export const PHYSICS_ROWS: SliderRow[] = [
  { key: 'dagLevelDistance', label: 'DAG level distance', min: 10, max: 200, step: 1 },
  { key: 'chargeStrength', label: 'Repulsion (charge)', min: -300, max: 0, step: 5 },
  { key: 'linkDistance', label: 'Link distance', min: 5, max: 200, step: 1 },
  {
    key: 'velocityDecay',
    label: 'Velocity decay',
    min: 0.05,
    max: 0.95,
    step: 0.01,
    format: (v) => v.toFixed(2),
  },
];

// The "Spread" tab — how open the layout settles and what shape it takes. These
// engine-cooling/collision knobs default to neutral (no change to the
// out-of-the-box settle); see the field docs in graphSettings.ts.
export const SPREAD_ROWS: SliderRow[] = [
  {
    key: 'alphaDecay',
    label: 'Settle rate (α decay)',
    min: 0.005,
    max: 0.06,
    step: 0.001,
    format: (v) =>
      `${v.toFixed(3)}${v <= 0.012 ? ' (more spread)' : v >= 0.04 ? ' (tight)' : ''}`,
  },
  {
    key: 'warmupTicks',
    label: 'Pre-settle ticks',
    min: 0,
    max: 200,
    step: 5,
    format: (v) => (v === 0 ? 'off' : `${v} ticks`),
  },
  {
    key: 'collideRadius',
    label: 'Node spacing',
    min: 0,
    max: 60,
    step: 1,
    format: (v) => (v === 0 ? 'off' : String(v)),
  },
];

// The radial tidy-tree untangle (Spread tab). One slider — how wide the seed
// rings are; the "Untangle now" button below re-applies it with the current
// values. Whether it runs automatically on load is the toggle beneath.
export const TIDY_ROWS: SliderRow[] = [
  {
    key: 'tidySpread',
    label: 'Radial spread',
    min: 0.3,
    max: 2.5,
    step: 0.05,
    format: (v) => `${v.toFixed(2)}×${v === 1 ? ' (auto)' : ''}`,
  },
];

// Only meaningful in n-body mode; shown right under the mode toggle.
export const THETA_ROW: SliderRow = {
  key: 'chargeTheta',
  label: 'N-body accuracy (θ)',
  min: 0.5,
  max: 2.5,
  step: 0.1,
  format: (v) => `${v.toFixed(1)} (${v <= 1 ? 'precise' : v >= 1.8 ? 'fastest' : 'fast'})`,
};

export const LINK_WIDTH_ROW: SliderRow = {
  key: 'linkWidth',
  label: 'Link width',
  min: 0,
  max: 3,
  step: 0.1,
  format: (v) => (v === 0 ? 'flat lines' : `${v.toFixed(1)} (tubes)`),
};

// The selection-halo glow knobs (Rendering tab). The pulsing bloom that
// brightens selected nodes — strength is its peak opacity (0 = ring only), size
// its radius as a multiple of node size. See halo.ts.
export const SELECTION_GLOW_ROWS: SliderRow[] = [
  {
    key: 'selectionGlowStrength',
    label: 'Selection glow',
    min: 0,
    max: 1,
    step: 0.05,
    format: (v) => (v === 0 ? 'off (ring only)' : v.toFixed(2)),
  },
  {
    key: 'selectionGlowScale',
    label: 'Selection glow size',
    min: 0.8,
    max: 3,
    step: 0.1,
    format: (v) => `${v.toFixed(1)}×`,
  },
];

// Renderer pixel-ratio cap. The big lever when the browser is software-rendering
// (no GPU hardware acceleration) — lower it to render fewer pixels per frame.
export const RENDER_SCALE_ROW: SliderRow = {
  key: 'pixelRatio',
  label: 'Render scale',
  min: 0.25,
  max: 2,
  step: 0.05,
  format: (v) => `${v.toFixed(2)}×${v < 1 ? ' (faster)' : ''}`,
};

export type ToggleOption<T> = { value: T; label: string; hint: string };

export const REPULSION_MODES: ToggleOption<RepulsionMode>[] = [
  { value: 'nbody', label: 'N-body', hint: 'd3 forceManyBody (global, default)' },
  { value: 'local', label: 'Local (fast)', hint: 'O(N) tree-aware repulsion' },
];

export const LINK_MODES: ToggleOption<boolean>[] = [
  { value: false, label: 'Per-link', hint: 'one Line/tube per link' },
  {
    value: true,
    label: 'Batched (fast)',
    hint: 'all links in one LineSegments — 1 draw call when orbiting (default)',
  },
];

export const NODE_MODES: ToggleOption<boolean>[] = [
  { value: false, label: 'Per-node', hint: 'one Sprite per node' },
  {
    value: true,
    label: 'Batched (fast)',
    hint: 'instanced shapes — ~1 draw call per file type when orbiting (default)',
  },
];

// Whether the radial tidy-tree untangle runs automatically on each load.
export const TIDY_ONLOAD_MODES: ToggleOption<boolean>[] = [
  {
    value: true,
    label: 'On load',
    hint: 'untangle into a radial tidy tree each time the project loads (default)',
  },
  {
    value: false,
    label: 'Off',
    hint: "keep the library's raw seed; use the button below to untangle on demand",
  },
];

// Whether the LOC (Z) / health (H) overlays draw their per-node numeric value
// labels. Off by default — in dense projects the labels overlap so much they
// obscure the recolor; the tinted shapes alone still read by color.
export const METRIC_LABEL_MODES: ToggleOption<boolean>[] = [
  { value: false, label: 'Off', hint: 'color only — no overlapping numbers (default)' },
  {
    value: true,
    label: 'On',
    hint: 'show the numeric value above each node on the Health (H) and LOC (Z) views',
  },
];

// Whether each subagent satellite orb draws its type label (e.g. 'Explore') in
// the Agent Presence Layer. Off by default — the orbs alone convey that an
// agent spawned subagents; the labels add clutter without much signal. The orbs
// themselves are always shown either way.
export const SUBAGENT_LABEL_MODES: ToggleOption<boolean>[] = [
  { value: false, label: 'Off', hint: 'satellite orbs only — no type labels (default)' },
  {
    value: true,
    label: 'On',
    hint: "show each subagent's type label next to its satellite orb",
  },
];
