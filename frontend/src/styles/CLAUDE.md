# frontend/src/styles

Feature-scoped CSS. `../index.css` is just an ordered `@import` list; every
rule lives in one of the files here. No MUI, no CSS-in-JS — hand-written CSS
plus `lucide-react` icons.

The **canonical file → class-name map** (which class lives where, plus the
cascade-sensitive notes) is the table in `../components/CLAUDE.md`. This file
is only the navigation summary.

## Import / aggregation order

`index.css` imports in cascade order, **foundational layers first** so
tokens, base resets, shared controls, and `@keyframes` resolve before any
feature rule references them: `tokens` → `base` → `layout` → `controls`,
then the feature modules. Two features are **aggregators** that fan out to an
ordered partial folder, each `@import`ed in its own cascade order:

- `taskboard.css` → `taskboard/` (`shell`, `lanes`, `cards`, `filters`,
  `lane-actions`, `detail`, `toast`, `forms`, `post-merge-hook`)
- `workflows.css` → `workflows/` (`shell`, `list`, `templates`,
  `editor-shell`, `runs-shell`, `queue`, `runs`, `editor-empty`, `editor`,
  `variables`, `steps`, `actions`, `chips`)
- `settings.css` → `settings/` (`shell` — dialog chrome + sections + controls +
  startup list + the `SettingsInfo` info-popover; `pi` — managed endpoints +
  advanced; `env-notes`; `prompts`; `mcp`). Shell imports first (its
  section/control/checkbox base is built on by the later tabs).
- `graph.css` → `graph/` (`hud-search` — overlay/search/counts + loc-view chip;
  `overlay-key`; `context-menu` — box-select rect + selection chip + node menu;
  `settings-panel` — gear FAB + settings popover; `toast`). Imported in the
  original source order (each partial targets a disjoint class group).

Adding a partial means adding an `@import` to the aggregator at the position
its cascade needs — files are not auto-globbed.

## Where each feature lives

- **Settings** — `settings.css` aggregator → `settings/` partials (`.settings-*`,
  `.startup-*`, `.env-note-*`, `.prompt-tpl-*`, `.mcp-*`, `.settings-info-*`).
- **Graph** — `graph.css` aggregator → `graph/` partials (overlay, search/counts
  cluster, context menu, settings fab/panel, toasts); `health-overlay.css` owns
  the `H`/`D` health legend + tooltip; `legend.css` owns the per-extension
  legend.
- **Health** — `health-overlay.css` (`.health-legend*`, `.health-tooltip*`).
- **Task board** — `taskboard.css` + `taskboard/` partials.
- **Workflows** — `workflows.css` + `workflows/` partials.

## Convention

Put a new rule in the feature file (or partial) that owns its class, not
wherever it's convenient. Shared low-level controls (`.icon-btn`,
`.btn-primary`, `.text-input`, `.spinner`, `.popover`, …) live in
`controls.css` and import *before* every feature file — if a feature needs
to override one, add the rule to the feature file (which imports later) so it
wins on order, rather than editing `controls.css`. Class names are global and
unchanged across the split, so a misplaced one-off edit still "works" but
rots the map — keep edits co-located.
