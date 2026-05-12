# taskboard

Components behind the Tasks button. `TaskBoard.tsx` (parent dir) is a re-export shim.

## Modules

- `TaskBoardLauncher.tsx` — top-level component that owns panel-only UI state and wires taskboard hooks to JSX.
- `Lane.tsx` — one kanban column. Drop slots between cards for explicit positioning; lane background drop = status-only move. Per-lane "run all" config in `laneRunAllConfig`.
- `TaskCard.tsx` — single row. Surfaces conflict pill + StuckPill + lane-appropriate action buttons.
- `NewTaskOverlay.tsx` — modal for creating a task in a specific lane.
- `TaskDetailOverlay.tsx` — view/edit overlay; action row shifts based on task lane.
- `MergeRunStrip.tsx` — progress strip rendered above Ready-to-Merge during a backend run; switches to dismissable summary on done.
- `StuckPill.tsx` — "stuck Nm" surfaced after a conflict resolver runs > 3 min.
- `lanes.ts` — `LANES` array, `LANE_BY_ID` map, `DRAG_MIME` constant, `shortLabel()`.
- `hooks/useTaskBoardState.ts` — combines task-list syncing, lane grouping/sorting, active counts, and multi-selection.
- `hooks/useTaskActions.ts` — routes task CRUD/lifecycle/reorder callbacks to the API and terminal spawning.

## Drag MIME

Cards use `application/x-lattice-task` (defined in `lanes.ts`). Setting both that and `text/plain` keeps the drag readable for non-task drop targets.
