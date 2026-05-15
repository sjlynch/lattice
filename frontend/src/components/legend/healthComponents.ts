// Static breakdown of the code health score. Shown in place of the
// regular extensions legend while the user holds `h` in the graph view.
// Per-file scores live in the on-graph hover tooltip; this panel only
// describes what the score means and how it's weighted.
//
// Score ids, order, weights, thresholds, and direction come from the
// backend's serializable score metadata so the legend cannot drift from
// computeScore. UI labels/detail copy intentionally live here.

import {
  SCORE_COMPONENT_METADATA,
  type ScoreComponentId,
} from '../../../../backend/src/health/scoreMetadata';

export type HealthComponentId = ScoreComponentId;

// Structured tooltip detail. Rendering puts the bolded label on its
// own line followed by the body text, so users get a readable list
// rather than a wall of prose.
export type DetailEntry = { label: string; body: string };

type HealthComponentCopy = {
  label: string;
  note: string;
  detail: DetailEntry[];
};

export type HealthComponent = {
  id: HealthComponentId;
  label: string;
  weight: number;
  healthyThreshold: number;
  unhealthyThreshold: number;
  higherIsWorse: boolean;
  note: string;
  detail: DetailEntry[];
};

const HEALTH_COMPONENT_COPY = {
  cognitive_complexity: {
    label: 'Cognitive complexity (max)',
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
        body: 'TypeScript, JavaScript, Python, Go, Rust, Java, C#, Ruby.',
      },
    ],
  },
  cyclomatic_complexity: {
    label: 'Cyclomatic complexity (max)',
    note: 'green ≤5 · red ≥25',
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
        body: '≤5 no score penalty · 6–20 moderate · ≥25 has the full score penalty.',
      },
      {
        label: 'Languages',
        body: 'TypeScript, JavaScript, Python, Go, Rust, Java, C#, Ruby.',
      },
    ],
  },
  maintainability_index: {
    label: 'Maintainability Index',
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
        body: 'TypeScript, JavaScript, Python, Go, Rust, Java, C#, Ruby.',
      },
    ],
  },
  nesting_depth: {
    label: 'Nesting depth (max)',
    note: 'green ≤2 · red ≥8',
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
        body: '≤2 no score penalty · 3–5 dense · ≥8 has the full score penalty.',
      },
      {
        label: 'Languages',
        body: 'TypeScript, JavaScript, Python, Go, Rust, Java, C#, Ruby.',
      },
    ],
  },
  function_length: {
    label: 'Max function length',
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
        body: 'TypeScript, JavaScript, Python, Go, Rust, Java, C#, Ruby.',
      },
    ],
  },
  smell_density: {
    label: 'Smell density',
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
  call_graph_density: {
    label: 'Call graph density',
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
        body: 'TypeScript, JavaScript, Python, Go, Rust, Java, C#, Ruby.',
      },
    ],
  },
  file_size: {
    label: 'File size (LOC)',
    note: 'green ≤200 · red ≥1500',
    detail: [
      {
        label: 'Measures',
        body: 'Total lines, including blank and comment lines.',
      },
      {
        label: 'Threshold',
        body: '≤200 no score penalty · 300–800 normal · >800 tends to mix concerns and resist code review.',
      },
      {
        label: 'Special cases',
        body: 'Files under 30 LOC skip scoring entirely and are treated as fully healthy.',
      },
    ],
  },
  fan_out: {
    label: 'Fan-out (imports made)',
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
  fan_in: {
    label: 'Fan-in (importers)',
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
  circular_dependency: {
    label: 'Circular dependency',
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
} satisfies Record<HealthComponentId, HealthComponentCopy>;

export const HEALTH_COMPONENTS: HealthComponent[] = SCORE_COMPONENT_METADATA.map(
  (component) => ({
    ...component,
    ...HEALTH_COMPONENT_COPY[component.id],
    weight: Math.round(component.weight * 100),
  }),
);
