# frontend/src/components

## Top-level files

- `TopAppBar.tsx` — folder picker + workflow/taskboard launchers.
- `Sidebar.tsx` + `sidebar/` — terminal tabs/panels + new-shell tray; `Sidebar.tsx` composes the split components/hooks and reads `useTerminals()`.
- `TerminalPane.tsx` — xterm.js + WS to `/ws/terminal` (proxied to `:5185`). The WebglAddon is attached only while `active=true` and disposed on deactivate so each tab doesn't permanently hold a WebGL context.
- `Legend.tsx` — composition layer for per-extension toggles. Row derivation lives in `legend/useLegendRows.ts`, rendering in `legend/LegendRow.tsx`, and shapes/colors still source from `extensionStyles.ts`.
- `FloatingPanel.tsx` + `floatingPanel/` — portal markup plus extracted geometry/state/drag/resize helpers; persists size/pos under `lattice.<thing>.window`. Titlebar double-click / top-right maximize icon toggle an OS-style full-window maximize (restore returns to the prior pos/size).
- `Modal.tsx` — generic backdrop overlay used by ForceGraph's "create task" flow.
- `FolderPicker.tsx` + `folderPicker/` — backend-paged folder browser, with state in `useFolderPickerState` and focused row/list components.
- `SettingsDialog.tsx` + `settings/` — settings tabs (Terminals / Agent prompts / Metrics / Agents / Pi / MCP) hosted in a **`FloatingPanel`** (draggable/resizable/maximizable, no backdrop — the app behind it stays interactive; titlebar carries the `×` close + maximize; geometry persists under `lattice.settings.window`), not a modal `Modal`; keep the ref handles as thin save adapters and put per-tab draft state in focused `use*Draft` hooks. The "Pi" tab (`settings/PiTab.tsx`) manages Pi endpoints + the model-menu curation (machine-global).

## Big launchers (split into subdirs)

- `TaskBoard.tsx` → `taskboard/`. Kanban + drag-drop + per-card actions + merge-run strip.
- `Workflows.tsx` → `workflows/`. Workflow editor + saved-list sidebar + run strip.
- `ForceGraphView.tsx` → `forceGraph/`. 3D graph + LOC overlay + box-select + settings panel.

The top-level `*.tsx` files are one-line re-export shims; implementation is in each subdir's `*Launcher.tsx` (taskboard/workflows) or `ForceGraphView.tsx` (forceGraph).

## Shared

- `shared/ErrorToast.tsx` — copy-button error toast used by both TaskBoard and Workflows.

## Styles

`frontend/src/index.css` is now an ordered `@import` list. Feature-scoped
stylesheets live in `frontend/src/styles/`. Class names are unchanged —
the split is purely organizational. Import order matters: foundational
layers first (so cascade and `@keyframes` references resolve), feature
modules after.

| File | What lives here |
|------|-----------------|
| `tokens.css` | `:root` design tokens (colors, radii, shadows, fonts) |
| `base.css` | Element resets (`*`, `html`/`body`/`#root`, `button`, `input`, `::selection`, scrollbar) |
| `layout.css` | App shell: `.app-shell`, `.app-body`, `.app-sidebar`, `.app-resizer`, `.app-graph` |
| `controls.css` | Shared low-level controls: `.icon-btn`, `.btn-primary`, `.btn-ghost`, `.text-input`, `.error-msg`, `.spinner` (+ `@keyframes spin`), `.popover` / `.popover-item` |
| `appbar.css` | `.appbar*`, `.fab` (taskboard launcher), `.wf-run-chip*` (workflow status chip) |
| `sidebar.css` | `.sidebar-*` — panel tabs, terminal tab strip, empty state, search, new-menu |
| `modal.css` | `.modal-backdrop`, `.modal`, `.modal-header/body/footer` (+ `@keyframes modal-fade`) |
| `settings.css` | Settings aggregator. Ordered partials under `styles/settings/`: `shell` (chrome/sections/controls/startup/`.settings-info-*`), `pi`, `env-notes`, `prompts`, `mcp` |
| `folder-picker.css` | `.path-row`, `.drive-*`, `.create-folder-*`, `.dir-list/row` |
| `graph.css` | Graph aggregator. Ordered partials under `styles/graph/`: `hud-search` (`.graph-overlay`/`.graph-bottom-left`/`.graph-search*`/`.graph-counts`/`.loc-view-chip`), `overlay-key`, `context-menu` (`.graph-select-rect`/`.graph-selection-chip`/`.graph-context-menu`), `settings-panel` (`.graph-settings-fab/panel`), `toast` |
| `terminal.css` | `.term-pane` |
| `floating-panel.css` | `.floating-panel*` (titlebar, body, resize grip) |
| `taskboard.css` | Taskboard aggregator. Ordered partials live under `styles/taskboard/`: `shell`, `lanes`, `cards`, `filters`, `lane-actions`, `detail`, `toast`, `forms` |
| `legend.css` | `.legend*`, `.swatch*` |
| `merge-run.css` | `.merge-run-strip*`, `.merge-run-stat*` |
| `workflows.css` | Workflows aggregator. Ordered partials live under `styles/workflows/`: `shell`, `list`, `templates`, `editor-shell`, `runs-shell`, `queue`, `runs`, `editor-empty`, `editor`, `steps`, `actions`, `chips` |
| `timeline.css` | Timeline scrubber: `.timeline-bar`, `.has-timeline` overrides, `.timeline-scrubber*`, `.ts-*` (+ `--timeline-h` token) |
| `health-overlay.css` | `.health-legend*` (incl. info popover), `.health-tooltip*` (+ health `@keyframes`) |

Cascade-sensitive moves to be aware of when editing:
- `.icon-btn`, `.btn-primary`, `.btn-ghost`, `.text-input`, `.error-msg`,
  `.spinner`, `.popover` were inlined throughout the old monolith; they
  now live in `controls.css` and import before all feature files. If
  you add a feature rule that needs higher specificity than a control,
  put it in the feature file (which imports later) rather than editing
  `controls.css`.
- `@keyframes spin` is defined in `controls.css` and reused by
  `.wf-run-chip-spinner` (appbar.css) and `.merge-run-strip-spinner`
  (merge-run.css). `@keyframes modal-fade` is defined in `modal.css` and
  reused by `.taskboard-overlay`. Keep the defining file imported before
  any file that references the animation.
- `timeline.css` adds a second `:root { --timeline-h: 64px }` block —
  the variable is timeline-local, so it stays co-located with timeline
  rules rather than moving to `tokens.css`.
