# frontend/src/components map

On demand (not auto-loaded): which component owns what, and the stylesheet →
class-name map. Rules for all components are in `CLAUDE.md` beside this file;
a subfolder's own rules are in its `CLAUDE.md`. Keep this map in step when you
add, move or delete a component or stylesheet.

## Top-level files

- `TopAppBar.tsx` — folder picker + workflow/taskboard launchers.
- `BackendConnectionIndicator.tsx` — quiet navbar pill ("Backend restarting — reconnecting…") shown while any live `subscribeWs` channel is down for more than 1.5 s (`api/ws.ts` `subscribeBackendConnection`), i.e. a backend restart. Informational only: WebSocket feeds reconnect/re-sync independently; start actions use caller-specific retry policies. Task Resume/workflow Run retry only definitely unaccepted transient failures and surface uncertain acknowledgements without replaying an unkeyed POST. See [API](../api/CLAUDE.md), [taskboard hooks](taskboard/hooks/CLAUDE.md), and [workflow hooks](workflows/hooks/CLAUDE.md).
- `fleet/` — the navbar **Fleet** panel (every project at once): `FleetLauncher.tsx` (FAB + FloatingPanel, `lattice.fleet.window`), `FleetPanel.tsx` (polls `GET /api/fleet` every 3 s while open; project cards + cross-project activity feed; the agent-control toggle → global `fleetAgentControl`), `FleetProjectCard.tsx` (incl. "Merge ready" → a merge run there), `FleetPromptForm.tsx` (launch an agent in that project), `FleetTerminalViewer.tsx` (any project's terminal as rendered text, polled; type / Enter / Esc / Ctrl+C), `FleetReviewList.tsx` (a card's finished work: Ready / QA lines with the second opinion's badge; expanding loads the summary), `FleetPeersPanel.tsx` (PCs: the gateway switch, invites, revoke, pair / unpair; paired PCs' projects render below this PC's with a `machine`). Copy in `fleetDerive.ts` (tested in `__tests__/fleetDerive.test.ts`).
- `PlanUsageChip.tsx` — navbar chip: Claude / Codex subscription usage (each provider's most-used window; popover lists every window, bar, reset time, notes). Polls `GET /api/plan-usage` every 5 min while visible; opening it asks for fresh numbers. Copy in `planUsageDerive.ts` (tested in `__tests__/planUsageDerive.test.ts`).
- `TerminalServerChip.tsx` — navbar chip shown only while the detached terminal-server runs an older build than the backend (update deferred until it has zero ptys). Polls `GET /api/terminal-server/status` every 60 s while visible; copy in `terminalServerChipDerive.ts` (tested in `__tests__/terminalServerChipDerive.test.ts`).
- `Sidebar.tsx` + `sidebar/` — terminal tabs/panels + new-shell tray; `Sidebar.tsx` composes the split components/hooks and reads `useTerminals()`.
- `TerminalPane.tsx` + `terminal/` — xterm.js + WS to `/ws/terminal` (backend `:5184`, bridged to the detached terminal-server on `:5185`); the pane is just `useRef`s wired into the three `terminal/` hooks (lifecycle / connection / active-WebGL). The WebglAddon is attached only while `active=true` and disposed on deactivate so each tab doesn't permanently hold a WebGL context (Chrome's ~16-per-page cap).
- `Legend.tsx` — composition layer for per-extension toggles. Row derivation lives in `legend/useLegendRows.ts`, rendering in `legend/LegendRow.tsx`, and shapes/colors still source from `extensionStyles.ts`.
- `FloatingPanel.tsx` + `floatingPanel/` — portal markup plus extracted geometry/state/drag/resize helpers; persists size/pos under `lattice.<thing>.window`. Titlebar double-click / top-right maximize icon toggle an OS-style full-window maximize (restore returns to the prior pos/size).
- `Modal.tsx` — generic portal backdrop overlay (focus-trap + mousedown-guard dismiss). Used by ForceGraph's create-task modal (`forceGraph/GraphTaskModal.tsx`), `FolderPicker`, and `shared/ConfirmDialog`.
- `ErrorBoundary.tsx` — class-based React error boundary (lucide fallback UI). Wraps `<App>` in `main.tsx` and, in a `compact` variant, the force-graph subtree in `App.tsx`, so a render fault shows a recoverable "Reload" card instead of blanking the whole app. Styles in `error-boundary.css`.
- `FolderPicker.tsx` + `folderPicker/` — backend-paged folder browser, with state in `useFolderPickerState` and focused row/list components. The create-folder row carries the "Initialize a git repo" checkbox (default on) — a just-created folder is empty by definition, so that path calls `initProjectGit` directly with no preview or dialog.
- `gitSetup/` — Git Setup: turn a folder that isn't a repo into one Lattice can run tasks in. `GitSetupProvider` mirrors `ConfirmProvider` — mount it near the app root and `await ensureGitRepo(path)` from any of the three entry points (navbar chip, task *create*, ▶ run); it probes first, resolves `true` with no UI for an existing repo, opens `GitSetupDialog` for `none` + `initable`, and explains-then-refuses everything else. **`nested` is never offered init** — a repo inside a repo is the worst outcome the feature can produce. A `repo` that is **`unborn`** (no commits — its first commit failed, typically on a missing git identity) is the one repo state that still opens the dialog: the chip reads "`<branch> · finish setup`", and the same init flow completes it (the backend skips `git init`). The folder picker's create-and-init path shows git's own stderr under a failed init, since that is where the identity fix commands are spelled out. Concurrent calls for one project are coalesced, so a "run all" asks once. `useGitSetupNonce()` bumps after a successful init so the navbar re-probes and re-subscribes to `/ws/git-branch`. Pure chip/copy/format logic is in `gitSetupDerive.ts` (unit-tested in `src/__tests__/gitSetupDerive.test.ts`). See `gitSetup/CLAUDE.md`.
- `SettingsDialog.tsx` + `settings/` — settings tabs (Terminals / Agent prompts / Metrics / Agents / Pi / MCP / Tools) hosted in a **`FloatingPanel`** (draggable/resizable/maximizable, no backdrop — the app behind it stays interactive; titlebar carries the `×` close + maximize; geometry persists under `lattice.settings.window`), not a modal `Modal`; keep the ref handles as thin save adapters and put per-tab draft state in focused `use*Draft` hooks. The "Pi" tab (`settings/PiTab.tsx`) manages Pi endpoints + the model-menu curation (machine-global). The "Tools" tab (`settings/ToolsTab.tsx`) is the Opengrep (SAST) engine / rule-pack installer (immediate, machine-global) plus this project's scan filter (saved with the footer). See `settings/CLAUDE.md`.

## Big launchers (split into subdirs)

- `TaskBoard.tsx` → `taskboard/`. Kanban + drag-drop + per-card actions + merge-run strip.
- `settings/TaskReviewSection.tsx` / `useTaskReviewDraft.ts` — per-project Second opinion controls; `taskboard/TaskCardSubcomponents.tsx` / `TaskDetailMeta.tsx` show review state.
- `Workflows.tsx` → `workflows/`. Workflow editor + saved-list sidebar + run strip.
- `ForceGraphView.tsx` → `forceGraph/`. 3D graph + LOC overlay + box-select + settings panel.

The top-level `*.tsx` files are one-line re-export shims; implementation is in each subdir's `*Launcher.tsx` (taskboard/workflows) or `ForceGraphView.tsx` (forceGraph).

## Shared (`shared/`, own CLAUDE.md)

- `shared/ErrorToast.tsx` — copy-button error toast used by both TaskBoard and Workflows.
- `shared/ConfirmDialog.tsx` — `ConfirmProvider` + `useConfirm()` (returns `{confirm, confirmUnsaved}`): promise-returning destructive / unsaved-changes confirmation modal (built on `Modal`).

## Styles

`frontend/src/index.css` is an ordered `@import` list; feature-scoped
stylesheets live in `frontend/src/styles/` (navigation summary and aggregation
order: `styles/CLAUDE.md`). Class names are global; the split is purely
organizational. Import order matters: foundational layers first (so cascade and
`@keyframes` references resolve), feature modules after. The cascade rules are
in `CLAUDE.md` beside this file → "Styles".

| File | What lives here |
|------|-----------------|
| `tokens.css` | `:root` design tokens (colors, radii, shadows, fonts) |
| `base.css` | Element resets (`*`, `html`/`body`/`#root`, `button`, `input`, `::selection`, scrollbar) |
| `layout.css` | App shell: `.app-shell`, `.app-body`, `.app-sidebar`, `.app-resizer`, `.app-graph` |
| `controls.css` | Shared low-level controls: `.icon-btn`, `.btn-primary`, `.btn-ghost`, `.text-input`, `.error-msg`, `.spinner` (+ `@keyframes spin`), `.popover` / `.popover-item` |
| `fleet.css` | `.fleet*` (the Fleet panel: bar, project cards, terminal chips, prompt form, activity feed, terminal viewer) |
| `appbar.css` | `.appbar*` (incl. the git slot: `.appbar-branch`, its `-action` button variant for "Set up Git" and its `-warning` tint for `nested`), `.fab` (taskboard launcher), `.wf-run-chip*` (workflow status chip), `.appbar-term-update*` (terminal-server update-pending chip), `.appbar-usage*` (plan-usage chip + popover), `.appbar-conn*` (backend-reconnecting pill) |
| `sidebar.css` | `.sidebar-*` — panel tabs, terminal tab strip, empty state, search, new-menu |
| `modal.css` | `.modal-backdrop`, `.modal`, `.modal-header/body/footer` (+ `@keyframes modal-fade`) |
| `confirm-dialog.css` | `.confirm-dialog-message`, `.btn-danger` (`shared/ConfirmDialog`) |
| `settings.css` | Settings aggregator. Ordered partials under `styles/settings/`: `shell` (chrome/sections/controls/startup/`.settings-info-*`), `pi`, `env-notes`, `prompts` (template cards and `.task-writing-*` rules/Spec gaps preview), `mcp`, `tools` (`.tools-*` — the Opengrep engine/pack cards + scan-filter textareas) |
| `folder-picker.css` | `.path-row`, `.drive-*`, `.create-folder-row/input`, `.dir-list/row` |
| `git-setup.css` | `.git-setup-*` (Git Setup dialog) + the folder picker's `.create-folder-block/git` and `.git-setup-inline-note`. Imported after `modal.css` so `.modal-header.git-setup-header` wins on order; the navbar chip's own rules stay in `appbar.css` |
| `graph.css` | Graph aggregator. Ordered partials under `styles/graph/`: `hud-search` (`.graph-overlay`/`.graph-bottom-left`/`.graph-search*`/`.graph-counts`/`.loc-view-chip`), `overlay-key`, `security` (`.graph-security-*`/`.security-panel*`/`.security-finding*`/`.security-tooltip*`), `context-menu` (`.graph-select-rect`/`.graph-selection-chip`/`.graph-context-menu`), `settings-panel` (`.graph-settings-fab/panel`), `toast`, `renderer-notice` (`.graph-view-root` + `.graph-renderer-notice*` — the WebGL-renderer failure/recovery notice over the viewport) |
| `terminal.css` | `.term-pane` |
| `floating-panel.css` | `.floating-panel*` (titlebar, body, resize grip) |
| `taskboard.css` | Taskboard aggregator. Ordered partials live under `styles/taskboard/`: `shell`, `lanes`, `cards`, `filters`, `lane-actions`, `detail`, `toast`, `forms`, `post-merge-hook` (`.post-merge-hook-*` — the collapsible post-merge hook config strip below the lanes) |
| `legend.css` | `.legend*`, `.swatch*` |
| `merge-run.css` | `.merge-run-strip*`, `.merge-run-stat*` |
| `workflows.css` | Workflows aggregator. Ordered partials live under `styles/workflows/`: `shell`, `list`, `templates`, `editor-shell`, `runs-shell`, `queue`, `runs`, `editor-empty`, `editor`, `variables` (`.workflows-vars*` / `.workflows-var-*` — the collapsible Variables panel atop the editor), `steps`, `actions`, `chips` |
| `timeline.css` | Timeline scrubber: `.timeline-bar`, `.has-timeline` overrides, `.timeline-scrubber*`, `.ts-*` (+ `--timeline-h` token) |
| `health-overlay.css` | `.health-legend*` (incl. info popover), `.health-tooltip*` (+ health `@keyframes`) |
| `error-boundary.css` | `.error-boundary*` (ErrorBoundary fallback card) |

- `workflows/SplitPanel.tsx`, `workflows/splitAreas.ts` - single-step runtime split editor and custom-area helpers.
- `workflows/WorkflowRunSteps.tsx`, `workflows/splitRunGroups.ts` - grouped run member rows.
- `styles/workflows/split.css` - `.workflows-split-*`, `.workflows-run-steps`.
