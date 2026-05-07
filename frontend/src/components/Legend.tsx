import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, ChevronRight, Eye, EyeOff, Info } from 'lucide-react';
import {
  EXT_STYLES,
  DEFAULT_STYLE,
  type ExtStyle,
  type Shape,
} from '../extensionStyles';
import type { ScanResult } from '../api';

type Props = {
  data: ScanResult | null;
  hiddenExts: Set<string>;
  onToggleExt: (ext: string) => void;
  // While `h` is held in the graph, the legend swaps to a static
  // breakdown of what the health score is composed of. Per-file
  // breakdowns appear in the on-graph hover tooltip instead.
  healthMode?: boolean;
};

type Row = {
  key: string; // canonical ext (lowercased) — '*' for unknown
  style: ExtStyle;
  label: string;
  count: number;
};

const STORAGE_OPEN = 'lattice.legend.open';
const STORAGE_ALL = 'lattice.legend.all';

export function Legend({ data, hiddenExts, onToggleExt, healthMode }: Props) {
  const [open, setOpen] = useState<boolean>(() => {
    try {
      return localStorage.getItem(STORAGE_OPEN) === '1';
    } catch {
      return false;
    }
  });
  const [allOpen, setAllOpen] = useState<boolean>(() => {
    try {
      return localStorage.getItem(STORAGE_ALL) === '1';
    } catch {
      return false;
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_OPEN, open ? '1' : '0');
    } catch {
      // ignore
    }
  }, [open]);
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_ALL, allOpen ? '1' : '0');
    } catch {
      // ignore
    }
  }, [allOpen]);

  // Tally extensions present in the current scan.
  const visibleRows: Row[] = useMemo(() => {
    if (!data) return [];
    const counts = new Map<string, number>();
    const customStyles = new Map<string, ExtStyle>();
    for (const n of data.nodes) {
      if (n.kind !== 'file') continue;
      const key = (n.ext ?? '').toLowerCase() || '*';
      counts.set(key, (counts.get(key) ?? 0) + 1);
      if (key !== '*' && !EXT_STYLES[key] && !customStyles.has(key)) {
        customStyles.set(key, { ...DEFAULT_STYLE, ext: key, label: key });
      }
    }
    const rows: Row[] = [];
    for (const [key, count] of counts) {
      const style =
        EXT_STYLES[key] ??
        customStyles.get(key) ??
        { ...DEFAULT_STYLE, ext: key, label: key === '*' ? 'Other' : key };
      rows.push({ key, style, label: style.label, count });
    }
    rows.sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count;
      return a.key.localeCompare(b.key);
    });
    return rows;
  }, [data]);

  // All known styles not present in the current scan.
  const allOtherRows: Row[] = useMemo(() => {
    const visibleKeys = new Set(visibleRows.map((r) => r.key));
    const rows: Row[] = [];
    for (const key of Object.keys(EXT_STYLES)) {
      if (visibleKeys.has(key)) continue;
      rows.push({ key, style: EXT_STYLES[key], label: EXT_STYLES[key].label, count: 0 });
    }
    rows.sort((a, b) => a.style.label.localeCompare(b.style.label));
    return rows;
  }, [visibleRows]);

  // While the user holds `h`, swap the entire legend body for a health
  // breakdown panel. Hooks above must run unconditionally to satisfy the
  // rules of hooks; the swap happens here in render.
  if (healthMode) {
    return <HealthLegendPanel />;
  }

  return (
    <div className={`legend ${open ? 'open' : ''}`}>
      <button
        className="legend-toggle"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label="Legend"
      >
        <ShapePreview style={DEFAULT_STYLE} size={11} />
        <span>Legend</span>
        <ChevronDown
          size={13}
          className={`legend-caret ${open ? 'flip' : ''}`}
        />
      </button>

      {open && (
        <div className="legend-body">
          <div className="legend-section-head">
            <span className="legend-section-title">In this project</span>
            <span className="legend-section-count">
              {visibleRows.length}
            </span>
          </div>
          <div className="legend-rows">
            {visibleRows.length === 0 ? (
              <div className="legend-empty">No files yet.</div>
            ) : (
              visibleRows.map((r) => (
                <LegendRow
                  key={r.key}
                  row={r}
                  hidden={hiddenExts.has(r.key)}
                  onToggle={() => onToggleExt(r.key)}
                />
              ))
            )}
          </div>

          <button
            className="legend-section-head clickable"
            onClick={() => setAllOpen((v) => !v)}
          >
            {allOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            <span className="legend-section-title">All known types</span>
            <span className="legend-section-count">{allOtherRows.length}</span>
          </button>
          {allOpen && (
            <div className="legend-rows">
              {allOtherRows.map((r) => (
                <LegendRow
                  key={r.key}
                  row={r}
                  hidden={hiddenExts.has(r.key)}
                  onToggle={() => onToggleExt(r.key)}
                  muted
                />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function LegendRow({
  row,
  hidden,
  onToggle,
  muted,
}: {
  row: Row;
  hidden: boolean;
  onToggle: () => void;
  muted?: boolean;
}) {
  return (
    <button
      className={`legend-row ${hidden ? 'hidden' : ''} ${muted ? 'muted' : ''}`}
      onClick={onToggle}
      title={hidden ? 'Click to show' : 'Click to hide'}
    >
      <ShapePreview style={row.style} size={14} />
      <span className="legend-row-ext">{row.style.ext}</span>
      <span className="legend-row-label">{row.label}</span>
      <span className="legend-row-count">{row.count > 0 ? row.count : ''}</span>
      <span className="legend-row-eye">
        {hidden ? <EyeOff size={12} /> : <Eye size={12} />}
      </span>
    </button>
  );
}

// Inline SVG preview matching the canvas-drawn shapes in ForceGraphView.
// Two-color uses a linearGradient with hard 50% stops for the diagonal split.
function ShapePreview({
  style,
  size = 14,
}: {
  style: ExtStyle;
  size?: number;
}) {
  const fillId = `lg-${style.shape}-${sanitize(style.color1)}-${sanitize(
    style.color2 ?? '',
  )}`;
  const fill = style.color2 ? `url(#${fillId})` : style.color1;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      style={{ flex: '0 0 auto', display: 'block' }}
    >
      {style.color2 && (
        <defs>
          <linearGradient
            id={fillId}
            x1="0"
            y1="0"
            x2="100%"
            y2="100%"
          >
            <stop offset="50%" stopColor={style.color2} />
            <stop offset="50%" stopColor={style.color1} />
          </linearGradient>
        </defs>
      )}
      <ShapeSvg shape={style.shape} fill={fill} />
    </svg>
  );
}

function ShapeSvg({ shape, fill }: { shape: Shape; fill: string }) {
  const stroke = 'rgba(0,0,0,0.45)';
  const strokeWidth = 0.6;
  switch (shape) {
    case 'circle':
      return (
        <circle cx={8} cy={8} r={6.6} fill={fill} stroke={stroke} strokeWidth={strokeWidth} />
      );
    case 'square':
      return (
        <rect
          x={1.6}
          y={1.6}
          width={12.8}
          height={12.8}
          rx={2.2}
          ry={2.2}
          fill={fill}
          stroke={stroke}
          strokeWidth={strokeWidth}
        />
      );
    case 'diamond':
      return (
        <polygon
          points="8,1 15,8 8,15 1,8"
          fill={fill}
          stroke={stroke}
          strokeWidth={strokeWidth}
        />
      );
    case 'hexagon': {
      // pointy-top hex
      const pts: string[] = [];
      for (let i = 0; i < 6; i++) {
        const a = -Math.PI / 2 + (i * Math.PI) / 3;
        const x = 8 + 6.6 * Math.cos(a);
        const y = 8 + 6.6 * Math.sin(a);
        pts.push(`${x.toFixed(2)},${y.toFixed(2)}`);
      }
      return (
        <polygon
          points={pts.join(' ')}
          fill={fill}
          stroke={stroke}
          strokeWidth={strokeWidth}
        />
      );
    }
    case 'triangle': {
      const pts: string[] = [];
      for (let i = 0; i < 3; i++) {
        const a = -Math.PI / 2 + (i * 2 * Math.PI) / 3;
        const x = 8 + 6.8 * Math.cos(a);
        const y = 8 + 6.5 * Math.sin(a);
        pts.push(`${x.toFixed(2)},${y.toFixed(2)}`);
      }
      return (
        <polygon
          points={pts.join(' ')}
          fill={fill}
          stroke={stroke}
          strokeWidth={strokeWidth}
        />
      );
    }
  }
}

function sanitize(s: string): string {
  return s.replace(/[^a-z0-9]/gi, '');
}

// ---------- HealthLegendPanel ----------
//
// Static breakdown of the code health score. Shown in place of the
// regular extensions legend while the user holds `h` in the graph view.
// Per-file scores live in the on-graph hover tooltip; this panel only
// describes what the score means and how it's weighted.

// Structured tooltip detail. Rendering puts the bolded label on its
// own line followed by the body text, so users get a readable list
// rather than a wall of prose.
type DetailEntry = { label: string; body: string };

type HealthComponent = {
  label: string;
  weight: number;
  note: string;
  detail: DetailEntry[];
};

const HEALTH_COMPONENTS: HealthComponent[] = [
  {
    label: 'Cognitive complexity (max)',
    weight: 20,
    note: 'green ≤5 · red ≥30',
    detail: [
      {
        label: 'Measures',
        body: 'How hard the most complex function in the file is to follow — based on the cognitive load a reader has to track, not the path count.',
      },
      {
        label: 'How it differs from cyclomatic',
        body: 'Penalizes nested control flow more than sequential; treats short-circuit operator chains as one unit; ignores trivial structures. Better predictor of "is this hard to read".',
      },
      {
        label: 'Threshold',
        body: '≤5 healthy · ≤15 moderate · ≥30 likely needs refactoring.',
      },
      {
        label: 'Languages',
        body: 'TypeScript, JavaScript, Python.',
      },
    ],
  },
  {
    label: 'Cyclomatic complexity (max)',
    weight: 15,
    note: 'green ≤10 · red ≥25',
    detail: [
      {
        label: 'Measures',
        body: 'Independent paths through the most-branchy function — McCabe\'s classic complexity number.',
      },
      {
        label: 'What counts',
        body: 'Each if, for, while, case, catch, ternary, &&, ||, ?? adds 1, starting from 1.',
      },
      {
        label: 'Threshold',
        body: '≤10 simple · 11–20 moderate · 21+ usually needs refactoring.',
      },
      {
        label: 'Languages',
        body: 'TypeScript, JavaScript, Python.',
      },
    ],
  },
  {
    label: 'Maintainability Index',
    weight: 12,
    note: 'Microsoft formula · ≥85 healthy',
    detail: [
      {
        label: 'Measures',
        body: 'Combined 0–100 index of how maintainable the file is. Higher = better.',
      },
      {
        label: 'Formula',
        body: 'MI = 171 − 5.2 ln(Halstead volume) − 0.23 × avg CC − 16.2 ln(LOC), normalized to 0–100.',
      },
      {
        label: 'Threshold',
        body: '≥85 healthy · 65–84 moderate · <65 needs attention.',
      },
      {
        label: 'Languages',
        body: 'TypeScript, JavaScript, Python.',
      },
    ],
  },
  {
    label: 'Smell density',
    weight: 10,
    note: 'detected smells / LOC',
    detail: [
      {
        label: 'Measures',
        body: 'Total detected smells divided by LOC. A high density means concentrated technical debt, regardless of file size.',
      },
      {
        label: 'Universal smells',
        body: 'TODO/FIXME comments, magic numbers, magic strings (literals duplicated 3+ times), long string literals, commented-out code blocks.',
      },
      {
        label: 'TS/JS smells',
        body: 'any types, as casts, non-null !, @ts-ignore, console.*, debugger, eval, var keyword, ==/!=, deep optional chains, deep ternaries, mixed sync/async, boolean parameters, mixed default + named exports.',
      },
      {
        label: 'Python smells',
        body: 'print(), bare except, import *, mutable default arguments, global keyword, missing docstrings.',
      },
    ],
  },
  {
    label: 'Nesting depth (max)',
    weight: 10,
    note: 'green ≤3 · red ≥8',
    detail: [
      {
        label: 'Measures',
        body: 'How deep control structures are nested inside any one function — if inside for inside while, etc.',
      },
      {
        label: 'What counts',
        body: 'Each if, for, while, switch, try, catch, ternary adds one level. Functions reset the count for their own body.',
      },
      {
        label: 'Threshold',
        body: '≤3 readable · 4–5 dense · ≥6 usually means missing guard clauses or early returns.',
      },
      {
        label: 'Languages',
        body: 'TypeScript, JavaScript, Python.',
      },
    ],
  },
  {
    label: 'Max function length',
    weight: 8,
    note: 'green ≤30 · red ≥250 lines',
    detail: [
      {
        label: 'Measures',
        body: 'Lines belonging to the longest function\'s own scope, excluding nested callback bodies.',
      },
      {
        label: 'Why own-body',
        body: 'Counting own-body, not total, prevents React components from being penalized for the size of their useEffect callbacks (which are independently measured).',
      },
      {
        label: 'Threshold',
        body: '≤30 ideal · 30–75 normal · >75 the canonical "long function" smell.',
      },
      {
        label: 'Languages',
        body: 'TypeScript, JavaScript, Python.',
      },
    ],
  },
  {
    label: 'Call graph density',
    weight: 5,
    note: 'within-file calls per function',
    detail: [
      {
        label: 'Measures',
        body: 'Average number of in-file functions each function calls.',
      },
      {
        label: 'What it tells you',
        body: 'Low values = independent helpers (good cohesion). High values = god-function patterns where one function orchestrates everything.',
      },
      {
        label: 'Related',
        body: 'A separate "god function" smell fires when any single function calls more than half the others in the file.',
      },
      {
        label: 'Languages',
        body: 'TypeScript, JavaScript, Python.',
      },
    ],
  },
  {
    label: 'File size (LOC)',
    weight: 5,
    note: 'green ≤300 · red ≥1500',
    detail: [
      {
        label: 'Measures',
        body: 'Total lines, including blank and comment lines.',
      },
      {
        label: 'Threshold',
        body: '≤300 healthy · 300–800 normal · >800 tends to mix concerns and resist code review.',
      },
      {
        label: 'Special cases',
        body: 'Files under 30 LOC skip scoring entirely and are treated as fully healthy.',
      },
    ],
  },
  {
    label: 'Fan-out (imports made)',
    weight: 5,
    note: 'green ≤8 · red ≥30',
    detail: [
      {
        label: 'Measures',
        body: 'Number of distinct in-project files this file imports.',
      },
      {
        label: 'What it tells you',
        body: 'High fan-out means the file knows about a lot of the codebase — Robert Martin\'s "instability" metric. Modules with many dependencies are harder to relocate or replace.',
      },
      {
        label: 'How it\'s computed',
        body: 'Resolved against actual file paths in the scanned project. External packages and unresolved specifiers are excluded.',
      },
    ],
  },
  {
    label: 'Fan-in (importers)',
    weight: 5,
    note: 'green ≤15 · red ≥50',
    detail: [
      {
        label: 'Measures',
        body: 'Number of distinct files in the project that import this one.',
      },
      {
        label: 'What it tells you',
        body: 'High fan-in is not always bad — utility modules naturally have many importers. But combined with high complexity it widens the blast radius of every change.',
      },
      {
        label: 'How it\'s computed',
        body: 'Counted across the whole scanned project. Updates live as files are saved.',
      },
    ],
  },
  {
    label: 'Circular dependency',
    weight: 5,
    note: 'binary · file is in a cycle',
    detail: [
      {
        label: 'Measures',
        body: 'Whether this file participates in an import cycle.',
      },
      {
        label: 'How it\'s detected',
        body: 'Tarjan\'s strongly-connected components algorithm on the project\'s import graph. Both direct cycles (A → B → A) and longer chains are caught.',
      },
      {
        label: 'Why it matters',
        body: 'Circular deps slow incremental builds, hide initialization-order bugs, and make refactors risky. Always worth breaking.',
      },
    ],
  },
];

function HealthLegendPanel() {
  return (
    <div className="legend open health-legend">
      <div className="legend-toggle health-legend-head">
        <span className="health-legend-dot" style={{ background: '#7ed884' }} />
        <span>Code Health</span>
        <span className="health-legend-hint">hold H</span>
      </div>
      <div className="legend-body">
        <div className="health-legend-scale">
          <div className="health-legend-scale-row">
            <span className="health-legend-swatch" style={{ background: '#f57878' }} />
            <span className="health-legend-scale-label">0–39 critical</span>
          </div>
          <div className="health-legend-scale-row">
            <span className="health-legend-swatch" style={{ background: '#f5d76e' }} />
            <span className="health-legend-scale-label">40–69 warn</span>
          </div>
          <div className="health-legend-scale-row">
            <span className="health-legend-swatch" style={{ background: '#7ed884' }} />
            <span className="health-legend-scale-label">70–100 healthy</span>
          </div>
        </div>

        <div className="legend-section-head">
          <span className="legend-section-title">Score components</span>
        </div>
        <div className="health-legend-rows">
          {HEALTH_COMPONENTS.map((c) => (
            <div className="health-legend-row" key={c.label}>
              <div className="health-legend-row-head">
                <span className="health-legend-row-label">{c.label}</span>
                <HealthInfoIcon component={c} />
                <span className="health-legend-row-weight">{c.weight}%</span>
              </div>
              <div className="health-legend-row-note">{c.note}</div>
            </div>
          ))}
        </div>

        <div className="health-legend-foot">
          Hover any file in the graph to see its score and breakdown.
          Files under 30 LOC are scored 100. Languages without a
          dedicated parser get a limited analysis (LOC + universal
          smells only).
        </div>
      </div>
    </div>
  );
}

// Info-icon button + portal-rendered popover. The popover MUST be
// portaled out of the legend because the legend (and its body, and
// the rows container) all establish overflow / scroll contexts that
// would clip an absolutely-positioned popover trying to render to the
// left of the icon. Portaling to document.body sidesteps every
// containing-block trap. Position is computed live from the icon's
// bounding rect so the popover stays glued to it during scroll/resize.
const POPOVER_WIDTH = 280;
const POPOVER_GAP = 10;
const POPOVER_VIEWPORT_PAD = 8;

function HealthInfoIcon({ component }: { component: HealthComponent }) {
  const iconRef = useRef<HTMLSpanElement>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);

  function compute() {
    const el = iconRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const centerY = r.top + r.height / 2;
    // Prefer the left side; flip right if the popover would overflow
    // the viewport's left edge.
    let x: number;
    if (r.left - POPOVER_GAP - POPOVER_WIDTH >= POPOVER_VIEWPORT_PAD) {
      x = r.left - POPOVER_GAP - POPOVER_WIDTH;
    } else {
      x = r.right + POPOVER_GAP;
    }
    setPos({ x, y: centerY });
  }

  return (
    <>
      <span
        ref={iconRef}
        className="health-legend-info-wrap"
        tabIndex={0}
        role="button"
        aria-label={`More info: ${component.label}`}
        onMouseEnter={compute}
        onMouseLeave={() => setPos(null)}
        onFocus={compute}
        onBlur={() => setPos(null)}
      >
        <Info size={11} className="health-legend-info-icon" />
      </span>
      {pos &&
        createPortal(
          <div
            className="health-legend-info-popover"
            style={{ left: pos.x, top: pos.y }}
            role="tooltip"
          >
            <div className="health-legend-info-popover-title">
              {component.label}
            </div>
            <dl className="health-legend-info-popover-body">
              {component.detail.map((entry) => (
                <div className="health-legend-info-entry" key={entry.label}>
                  <dt>{entry.label}</dt>
                  <dd>{entry.body}</dd>
                </div>
              ))}
            </dl>
          </div>,
          document.body,
        )}
    </>
  );
}
