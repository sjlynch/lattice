# taskboard

Components behind the Tasks button. `TaskBoard.tsx` (parent dir) is a re-export shim.

## Modules

- `TaskBoardLauncher.tsx` — top-level component that owns panel-only UI state and renders the FAB + FloatingPanel/chrome; taskboard hook composition lives in `hooks/useTaskBoardController.ts`.
- `TaskBoardPanelBody.tsx` — fans the controller's stable public surface into filters, lanes, overlays, post-merge row, and footer so the launcher stays chrome-only.
- `TaskBoardTitle.tsx` — FloatingPanel titlebar: title label + case-insensitive search box (Escape / ✕ clear).
- `TaskBoardFooter.tsx` — footer summary line: total/matching count, running-vs-queued spawn-queue indicator, interaction hints.
- `TaskBoardFilters.tsx` — lane visibility chips plus the task harness selector.
- `TaskBoardLaneGrid.tsx` — maps the visible lanes to `<Lane>` and owns every per-lane action decision (run-all gating under search, the QA-only Push / Playwright e2e buttons, per-lane sort wiring, merge-vs-bulk strip precedence). The launcher passes resolved hook outputs; all the `lane.id === 'qa'` / `searchActive` branching lives here so the launcher render stays a flat wiring shell.
- `Lane.tsx` — one kanban column. Drop slots between cards for explicit positioning; lane background drop = status-only move. Hosts the local `DropSlot` helper for the repeated between-card slot markup.
- `LaneHeader.tsx` — dot/title/count, lane-level run-all action, push, add. Layout only; the per-lane run-all copy/icon/disabled rules live in `laneRunAllConfig.ts`.
- `laneRunAllConfig.ts` — pure `laneRunAllConfig(id, tasks)` returning the per-lane bulk-action presentation (class/icon/disabled/copy) or `null` for lanes without one. Consumed by `LaneHeader.tsx`.
- `TaskCard.tsx` — single row composed from card body/actions/conflict-badge helpers. Also owns pure drag payload and selection-click intent helpers.
- `NewTaskOverlay.tsx` — modal for creating a task in a specific lane.
- `TaskDetailOverlay.tsx` — view/edit overlay; action row shifts based on task lane.
- `MergeRunStrip.tsx` — progress strip rendered above Ready-to-Merge during a backend run; switches to dismissable summary on done.
- `BulkRunStrip.tsx` — the same idea for the Open / In Progress / QA lane bulk actions (`Run all` / `Resume all` / `Mark all done`): a spinner strip with live "(X spawned, Y queued)" counts that auto-dismisses to a "Started N tasks" summary. Reuses the merge-run strip CSS. State lives in `hooks/useBulkRunStrips.ts`; the launcher `?? `s `bulkRunStripFor` after `mergeRunStripFor`.
- `StuckPill.tsx` — "stuck Nm" surfaced after a conflict resolver runs > 3 min.
- `lanes.ts` — `LANES` array, `LANE_BY_ID` map, `DRAG_MIME` constant, `shortLabel()`, `parseDragPayload()`.
- `laneSort.ts` — per-lane arrival-date sort: `LaneSortMode` (`recent`/`oldest`/`manual`, default `recent`), `arrivalTime(task, status)` (the lane-specific arrival stamp — startedAt/completedAt/mergedAt/doneAt, else createdAt), and `sortTasksForLane()`. Drives the lane header's clock + up/down caret control.
- `hooks/useTaskBoardController.ts` — top-level controller hook that composes data/view, run-controller, detail/editing, action, bulk-strip, and terminal concerns and returns the handlers/data the launcher renders.
- `hooks/useTaskBoardDataView.ts` — data/view slice for lane visibility, task list/grouping/selection, search filtering, display sorting, and drag state.
- `hooks/useTaskBoardDetailActions.ts` — new-task/detail overlay slice: synced viewed task plus callbacks adapting CRUD/run actions to the current overlay task.
- `hooks/useTaskBoardRunControllers.ts` — run-controller slice for merge-all, push, harness/model selection, QA Playwright/runs, and post-merge hook state.
- `hooks/useVisibilityPolling.ts` — shared lifecycle shell for visibility-aware interval polling with cancellation guards; push/QA callers keep their domain status and terminal-cleanup decisions.
- `hooks/useTaskBoardState.ts` — combines task-list syncing, lane grouping/sorting, active counts, and multi-selection.
- `hooks/useTaskSearch.ts` — search box state + case-insensitive title/description filtering; derives `filteredTasks`/`filteredGrouped` and the `searchActive` flag that gates lane run-all.
- `hooks/useVisibleLanes.ts` — lane visibility toggle set (all visible by default).
- `hooks/useLaneSort.ts` — per-lane `LaneSortMode` state (default `recent` = newest arrival on top), persisted per project under `lattice.laneSort.<path>`. `toggle` flips recent↔oldest; `setManual` is called when a card is dropped at an explicit slot so hand-ordering wins until the clock is clicked again.
- `hooks/useTaskList.ts` — fetches/subscribes to project tasks and returns an empty guarded list while switching folders until the new project's fetch/WS snapshot arrives, preventing stale cards from staying actionable under another project.
- `hooks/useTaskTerminalFocus.ts` — task→pty focus map (`getFocusTerminal`) plus a serverId-based focuser for the post-merge hook row.
- `hooks/useTaskTerminalCleanup.ts` — closes task terminals on lifecycle transitions (terminal statuses and ready-to-merge non-merge cleanup).
- `hooks/useSyncedViewedTask.ts` — keeps the task detail overlay's viewed task object fresh with live task-list updates.
- `hooks/useTaskActions.ts` — composes the four per-concern action hooks below into the single shape the launcher consumes. Add new actions in the matching focused hook, not here.
- `hooks/useTaskCrudActions.ts` — add/edit/delete plus the plain status-change `moveTask`.
- `hooks/useTaskReorderActions.ts` — `dropAt` / `moveMulti` / `dropAtMulti` lane reorder math (computes a new ID order and ships one batched reorder).
- `hooks/useTaskLifecycleActions.ts` — `runTask` / `resumeTaskAction` and the lane-level "run all" / "resume all" variants. Each action spawns the worktree-agent terminal.
- `hooks/useTaskMergeActions.ts` — `mergeTaskAction` (with resolver-Claude spawn on conflict), `mergeAllReady`, `cancelActiveRun`, `clearStuckConflicts` (the Resolving-strip Cancel button: aborts/clears orphaned conflict flags via `/merge-aborted`), `markAllQaDone`.
- `hooks/useQaPlaywright.ts` — the QA-lane Playwright MCP toggle (`userSettings.qaPlaywright`: enabled + headless). QA-e2e-runs-only — separate from the *global* `mcpOverrides.playwright` toggle in Settings → MCP. The backend reads it at spawn and applies it only to QA runs (`isQaRun`); `headless` is the eye-switch ("watch it test").
- `hooks/useQaRuns.ts` — QA-lane "run an e2e test" actions (`startQaRun`/`startAllQaRuns`), gated on `useQaPlaywright().enabled`. Each spawns a Playwright Claude session via `POST /api/qa-runs` in its own terminal tab and polls `/api/qa-runs/:id` to auto-close on done. The terminal carries **no** `taskId` (the task is in the `qa` lane; `useTaskTerminalCleanup` would otherwise close it instantly), so runs are tracked here by terminal id.
- `hooks/useLaneDropTargets.ts` — `isOver` + `hoverIndex` state, lane-background `onDragOver/onDragLeave/onDrop`, and `slotProps(idx)` factory used by `Lane.tsx`. Lane-background drops do status-only moves; slot drops set both status and position.
- `hooks/useTaskTerminalReattach.ts` — reattaches live but unmounted in-progress task ptys from `/api/terminals`; transient terminal-list failures and no-session startup races retry with bounded backoff before the per-project one-shot is claimed.

## Styles

Taskboard CSS is split under `frontend/src/styles/taskboard/`; `styles/taskboard.css` is the ordered aggregator with comments for `shell`, `lanes`, `cards`, `filters`, `lane-actions`, `detail`, `toast`, and `forms`.

## Drag MIME

Cards use `application/x-lattice-task` (defined in `lanes.ts`). Setting both that and `text/plain` keeps the drag readable for non-task drop targets.
