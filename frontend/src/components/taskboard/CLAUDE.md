# taskboard

Components behind the Tasks button. `TaskBoard.tsx` (parent dir) is a re-export shim.

## Modules

- `TaskBoardLauncher.tsx` — top-level component that owns panel-only UI state and wires taskboard hooks to JSX.
- `TaskBoardTitle.tsx` — FloatingPanel titlebar: title label + case-insensitive search box (Escape / ✕ clear).
- `TaskBoardFooter.tsx` — footer summary line: total/matching count, running-vs-queued spawn-queue indicator, interaction hints.
- `TaskBoardFilters.tsx` — lane visibility chips plus the task harness selector.
- `Lane.tsx` — one kanban column. Drop slots between cards for explicit positioning; lane background drop = status-only move. Hosts the local `DropSlot` helper for the repeated between-card slot markup.
- `LaneHeader.tsx` — dot/title/count, lane-level run-all action, push, add. `laneRunAllConfig` (per-lane copy/icon/disabled rules) lives here.
- `TaskCard.tsx` — single row composed from card body/actions/conflict-badge helpers. Also owns pure drag payload and selection-click intent helpers.
- `NewTaskOverlay.tsx` — modal for creating a task in a specific lane.
- `TaskDetailOverlay.tsx` — view/edit overlay; action row shifts based on task lane.
- `MergeRunStrip.tsx` — progress strip rendered above Ready-to-Merge during a backend run; switches to dismissable summary on done.
- `StuckPill.tsx` — "stuck Nm" surfaced after a conflict resolver runs > 3 min.
- `lanes.ts` — `LANES` array, `LANE_BY_ID` map, `DRAG_MIME` constant, `shortLabel()`, `parseDragPayload()`.
- `hooks/useTaskBoardState.ts` — combines task-list syncing, lane grouping/sorting, active counts, and multi-selection.
- `hooks/useTaskSearch.ts` — search box state + case-insensitive title/description filtering; derives `filteredTasks`/`filteredGrouped` and the `searchActive` flag that gates lane run-all.
- `hooks/useVisibleLanes.ts` — lane visibility toggle set (all visible by default).
- `hooks/useTaskTerminalFocus.ts` — task→pty focus map (`getFocusTerminal`) plus a serverId-based focuser for the post-merge hook row.
- `hooks/useTaskTerminalCleanup.ts` — closes task terminals on lifecycle transitions (terminal statuses and ready-to-merge non-merge cleanup).
- `hooks/useSyncedViewedTask.ts` — keeps the task detail overlay's viewed task object fresh with live task-list updates.
- `hooks/useTaskActions.ts` — composes the four per-concern action hooks below into the single shape the launcher consumes. Add new actions in the matching focused hook, not here.
- `hooks/useTaskCrudActions.ts` — add/edit/delete plus the plain status-change `moveTask`.
- `hooks/useTaskReorderActions.ts` — `dropAt` / `moveMulti` / `dropAtMulti` lane reorder math (computes a new ID order and ships one batched reorder).
- `hooks/useTaskLifecycleActions.ts` — `runTask` / `resumeTaskAction` and the lane-level "run all" / "resume all" variants. Each action spawns the worktree-agent terminal.
- `hooks/useTaskMergeActions.ts` — `mergeTaskAction` (with resolver-Claude spawn on conflict), `mergeAllReady`, `cancelActiveRun`, `markAllQaDone`.
- `hooks/useQaPlaywright.ts` — the QA-lane Playwright MCP toggle (`userSettings.qaPlaywright`: enabled + headless). QA-e2e-runs-only — separate from the *global* `mcpOverrides.playwright` toggle in Settings → MCP. The backend reads it at spawn and applies it only to QA runs (`isQaRun`); `headless` is the eye-switch ("watch it test").
- `hooks/useQaRuns.ts` — QA-lane "run an e2e test" actions (`startQaRun`/`startAllQaRuns`), gated on `useQaPlaywright().enabled`. Each spawns a Playwright Claude session via `POST /api/qa-runs` in its own terminal tab and polls `/api/qa-runs/:id` to auto-close on done. The terminal carries **no** `taskId` (the task is in the `qa` lane; `useTaskTerminalCleanup` would otherwise close it instantly), so runs are tracked here by terminal id.
- `hooks/useLaneDropTargets.ts` — `isOver` + `hoverIndex` state, lane-background `onDragOver/onDragLeave/onDrop`, and `slotProps(idx)` factory used by `Lane.tsx`. Lane-background drops do status-only moves; slot drops set both status and position.

## Styles

Taskboard CSS is split under `frontend/src/styles/taskboard/`; `styles/taskboard.css` is the ordered aggregator with comments for `shell`, `lanes`, `cards`, `filters`, `lane-actions`, `detail`, `toast`, and `forms`.

## Drag MIME

Cards use `application/x-lattice-task` (defined in `lanes.ts`). Setting both that and `text/plain` keeps the drag readable for non-task drop targets.
