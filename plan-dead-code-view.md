# Plan: Dead Code view (`D`) + detection-precision upgrade

Decisions: **tri-state coloring** (green / red / grey), **V2-accurate** scope.

## Goal

Hold `D` to recolor the graph by reachability:
- **Green** — reachable from an entry-point root (live).
- **Red** — unreachable + not a root + statically-analyzable language (high-confidence dead/orphaned).
- **Grey** — entry/root, non-code asset, unsupported-grammar language, or reached only via something we couldn't statically resolve (uncertain — deliberately not red).

Complements the existing right-click **"Find dead code"** agent action in `menu.ts`; does not replace it. Does **not** feed the health score (no new scored smell) — dead status is a separate flag.

---

## Part A — Detection (backend)

Today the only proxy is `fanIn === 0`, which is wrong both ways:
- **False positives:** entry points (`index.ts`, `main.tsx`, `*.config.*`, bins); re-export barrels (`export … from` not captured); dynamic `import()`/`require()`; imports of unresolved extensions (`.css/.vue/.svelte/.json/.svg`); test files.
- **False negatives:** dead islands / dead cycles (fanIn>0 but unreachable). `inCycle` files always have fanIn≥1 so circular dead code is invisible to the count.

Fix = **reachability from detected roots**, plus capturing more edges so reachability is accurate.

### A1. Keep the import edges (currently discarded)
`crossFile/graph.ts` builds `edges: Map<string, Set<string>>` inside `buildImportGraph` but `computeCrossFile` drops it, returning only counts. Thread `edges` (and the new reachability result) through `CrossFileResult`.

### A2. Root/entry-point detection — new `crossFile/roots.ts`
Build the root set from, cheapest first:
- `package.json` `main` / `module` / `exports` / `bin` at root, `backend/`, `frontend/`.
- Conventional names: `index.*`, `main.*`, `*.config.*`, `server.ts`, `vite.config.*`.
- Test globs: `*.test.*`, `*.spec.*`, `__tests__/**` (roots, so their dep trees count live).
- Optional HTML `<script src>` targets.
- **User escape hatch:** `deadCodeEntryGlobs: string[]` added to `UserSettings` (`backend/src/userSettings.ts`) for framework magic (file-based routing, DI registries). Read from `<project>/.lattice/userSettings.json`.

### A3. Capture more edge kinds (kills FP at the source) — `walker/visitors.ts` + `resolveImport.ts`
- `handleImportsAndStrings`: also capture `export … from './x'` (`export_statement` with a `source`) → push to `imports[]`.
- Capture `import('./x')` / `require('./x')` call expressions with a string-literal first arg.
- Broaden `RESOLVE_EXTS`/`INDEX_FILES` in `resolveImport.ts` to the full scanned `SOURCE_EXTS` set so asset/vue/svelte/json imports resolve.

### A4. Reachability — new `crossFile/reachability.ts`
BFS/DFS over `edges` from the root set → `reachable: Set<string>`. Classify each file:
- in roots → `entry`
- reachable → `live`
- statically-analyzable (has a grammar) + unreachable → `dead`
- else (no-grammar lang, asset, dynamic-only inbound) → `uncertain`

### A5. Surface on the node
- `health/types.ts`: add `deadCode?: 'live' | 'dead' | 'entry' | 'uncertain'` to `HealthMetrics`.
- `crossFile/apply.ts`: set it (alongside `fanIn`/`fanOut`/`inCycle`). **Do not** add a scored smell — leave `computeScore` untouched.
- `frontend/src/api/types/health.ts`: mirror the new field.
- Watcher path: `crossFileAnalyzer.ts` recomputes reachability on incremental changes (root set is cheap to recompute; reachability is a graph walk over the in-memory mirror).

### A6. Validation (dev-time only, not shipped)
Calibrate roots/edges by diffing against `knip` / `ts-prune` on this repo. Explicitly **not** SCIP, not a runtime dependency.

---

## Part B — The `D` view (frontend)

Model on the **`W` overlay** (`useWorktreeHighlight`) — a binary keydown-chord recolor, closer than the numeric LOC overlay.

### New files
- `hooks/useDeadCodeOverlay.ts` — `d`/`D` keydown→on, keyup→off, blur + visibilitychange reset, same guards as `h`/`z`/`w` (ignore ctrl/meta/alt, text input, `e.repeat`). Exposes `deadMode` + `deadModeRef`.
- `deadCodeOverlay.ts` — `spriteForDeadCode(node, settings)`: pure recolor (no numeric label / connector). Maps `node.healthDetails.deadCode` → green/red/grey, overrides `color1`, reuses `materialFor` so the cache stays one-material-per-(shape,color).

### Touched files
- `hooks/useGraphOverlays.ts` — compose `useDeadCodeOverlay`; return `deadMode` + ref.
- `nodeObjectFactory.ts` — add `deadModeRef` to `NodeObjectRefs`; new branch in `buildNodeObject` decision tree. Precedence: **health > loc > dead > labels** (consistent with current H>Z).
- `useForceGraphInitialization` — pass `deadModeRef` into the refs bundle.
- `ForceGraphView.tsx` — thread `deadMode` into `GraphHud`.
- `GraphHud.tsx` — `{deadMode && <div className="loc-view-chip">View: Dead Code</div>}`, slotted into the mutual-exclusion chain.
- `HealthTooltip.tsx` / `healthTooltipMetrics.ts` — add a "Reachability" line ("dead — no path from any entry point", "uncertain — dynamic-only reference", etc.).
- Optional legend block (green=reachable / red=dead / grey=entry·asset·uncertain) near the health legend.
- Size-change useEffect: clear/refresh on `fileNodeSize` change like the other overlays (no sim reheat).

---

## Staging / order of work
1. Backend A1–A5 (reachability + roots + edge capture + node field) — type-check `cd backend && npx tsc --noEmit`.
2. Frontend B (view) against the new field — type-check `cd frontend && npx tsc -b`.
3. Tooltip + legend polish.
4. Calibrate roots/edges vs `knip` (A6); add to `deadCodeEntryGlobs` as needed.

## Out of scope (note for later)
- Symbol-level unused exports (per-file unused `export` names, ts-prune-style) — would surface in the tooltip, not the coloring, since the graph is file-granular. Deferred (V3).
- CSS `@import` / `url()` edges — not parsed; CSS files stay "uncertain/grey" if not import-resolved from JS.
