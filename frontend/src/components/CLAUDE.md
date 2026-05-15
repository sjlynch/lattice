# frontend/src/components

## Top-level files

- `TopAppBar.tsx` — folder picker + workflow/taskboard launchers.
- `Sidebar.tsx` + `sidebar/` — terminal tabs/panels + new-shell tray; `Sidebar.tsx` composes the split components/hooks and reads `useTerminals()`.
- `TerminalPane.tsx` — xterm.js + WS to `/ws/terminal` (proxied to `:5185`). The WebglAddon is attached only while `active=true` and disposed on deactivate so each tab doesn't permanently hold a WebGL context.
- `Legend.tsx` — per-extension toggles. Sources `extensionStyles.ts`.
- `FloatingPanel.tsx` + `floatingPanel/` — portal markup plus extracted geometry/state/drag/resize helpers; persists size/pos under `lattice.<thing>.window`.
- `Modal.tsx` — generic backdrop overlay used by ForceGraph's "create task" flow.
- `FolderPicker.tsx` — backend-paged folder browser.

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
| `settings.css` | `.settings-*`, `.startup-*`, `.env-note-*` (Agent instructions tab) |
| `folder-picker.css` | `.path-row`, `.drive-*`, `.create-folder-*`, `.dir-list/row` |
| `graph.css` | `.graph-overlay`, `.loc-view-chip`, `.graph-select-rect`, `.graph-selection-chip`, `.graph-context-menu`, `.graph-settings-fab/panel`, `.graph-toast` (+ overlay `@keyframes`) |
| `terminal.css` | `.term-pane` |
| `floating-panel.css` | `.floating-panel*` (titlebar, body, resize grip) |
| `taskboard.css` | `.taskboard-*`, `.task-card*`, `.task-card-stuck-pill`, `.task-card-conflict-pill`, `.lane-runall*`, `.task-error-toast*` (+ `@keyframes toast-in`), `.taskboard-overlay`, `.taskboard-newform*`, `.taskboard-detail*`, `.task-card-form-*` |
| `legend.css` | `.legend*`, `.swatch*` |
| `merge-run.css` | `.merge-run-strip*`, `.merge-run-stat*` |
| `workflows.css` | `.workflows-*` (list, editor, runs panel, steps, prompt chips) |
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
