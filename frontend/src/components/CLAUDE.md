# frontend/src/components

## Top-level files

- `TopAppBar.tsx` — folder picker + workflow/taskboard launchers.
- `Sidebar.tsx` + `sidebar/` — terminal tabs/panels + new-shell tray; `Sidebar.tsx` composes the split components/hooks and reads `useTerminals()`.
- `TerminalPane.tsx` — xterm.js + WS to `/ws/terminal` (proxied to `:5185`). The WebglAddon is attached only while `active=true` and disposed on deactivate so each tab doesn't permanently hold a WebGL context.
- `Legend.tsx` — per-extension toggles. Sources `extensionStyles.ts`.
- `FloatingPanel.tsx` — draggable, resizable, persists size/pos under `lattice.<thing>.window`.
- `Modal.tsx` — generic backdrop overlay used by ForceGraph's "create task" flow.
- `FolderPicker.tsx` — backend-paged folder browser.

## Big launchers (split into subdirs)

- `TaskBoard.tsx` → `taskboard/`. Kanban + drag-drop + per-card actions + merge-run strip.
- `Workflows.tsx` → `workflows/`. Workflow editor + saved-list sidebar + run strip.
- `ForceGraphView.tsx` → `forceGraph/`. 3D graph + LOC overlay + box-select + settings panel.

The top-level `*.tsx` files are one-line re-export shims; implementation is in each subdir's `*Launcher.tsx` (taskboard/workflows) or `ForceGraphView.tsx` (forceGraph).

## Shared

- `shared/ErrorToast.tsx` — copy-button error toast used by both TaskBoard and Workflows.
