# taskboard

Components behind the Tasks button. `TaskBoard.tsx` (parent dir) is a re-export shim.

## Modules

- `TaskBoardLauncher.tsx` — top-level component that owns panel-only UI state and wires taskboard hooks to JSX.
- `TaskBoardFilters.tsx` — lane visibility chips plus the task harness selector.
- `Lane.tsx` — one kanban column. Drop slots between cards for explicit positioning; lane background drop = status-only move. Hosts the local `DropSlot` helper for the repeated between-card slot markup.
- `LaneHeader.tsx` — dot/title/count, lane-level run-all action, push, add. `laneRunAllConfig` (per-lane copy/icon/disabled rules) lives here.
- `TaskCard.tsx` — single row. Surfaces conflict pill + StuckPill + lane-appropriate action buttons.
- `NewTaskOverlay.tsx` — modal for creating a task in a specific lane.
- `TaskDetailOverlay.tsx` — view/edit overlay; action row shifts based on task lane.
- `MergeRunStrip.tsx` — progress strip rendered above Ready-to-Merge during a backend run; switches to dismissable summary on done.
- `StuckPill.tsx` — "stuck Nm" surfaced after a conflict resolver runs > 3 min.
- `lanes.ts` — `LANES` array, `LANE_BY_ID` map, `DRAG_MIME` constant, `shortLabel()`, `parseDragPayload()`.
- `hooks/useTaskBoardState.ts` — combines task-list syncing, lane grouping/sorting, active counts, and multi-selection.
- `hooks/useTaskActions.ts` — composes the four per-concern action hooks below into the single shape the launcher consumes. Add new actions in the matching focused hook, not here.
- `hooks/useTaskCrudActions.ts` — add/edit/delete plus the plain status-change `moveTask`.
- `hooks/useTaskReorderActions.ts` — `dropAt` / `moveMulti` / `dropAtMulti` lane reorder math (computes a new ID order and ships one batched reorder).
- `hooks/useTaskLifecycleActions.ts` — `runTask` / `resumeTaskAction` and the lane-level "run all" / "resume all" variants. Each action spawns the worktree-agent terminal.
- `hooks/useTaskMergeActions.ts` — `mergeTaskAction` (with resolver-Claude spawn on conflict), `mergeAllReady`, `cancelActiveRun`, `markAllQaDone`.
- `hooks/useLaneDropTargets.ts` — `isOver` + `hoverIndex` state, lane-background `onDragOver/onDragLeave/onDrop`, and `slotProps(idx)` factory used by `Lane.tsx`. Lane-background drops do status-only moves; slot drops set both status and position.

## Drag MIME

Cards use `application/x-lattice-task` (defined in `lanes.ts`). Setting both that and `text/plain` keeps the drag readable for non-task drop targets.
