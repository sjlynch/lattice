# frontend/src/components/taskboard/hooks

Where the taskboard's real logic lives. `../TaskBoardLauncher.tsx` is panel
chrome; `useTaskBoardController.ts` composes everything below into the one shape
it renders. Components, lanes and pure helpers: `../CLAUDE.md`. HTTP/WS
bindings and the retry policy: `../../../api/CLAUDE.md`.

## Map

Composition (put new cross-concern wiring in the controller; a new action in
its focused hook, never in `useTaskActions`):

- `useTaskBoardController.ts` — top level: spawn handler → data view → runs → actions → bulk → terminals → detail.
- `useTaskBoardDataView.ts` — lane visibility, task list, search, selection, lane sort, drag affordances.
- `useTaskBoardRunControllers.ts` — merge-run sync, push, harness, QA Playwright, QA runs, post-merge hook.
- `useTaskBoardDetailActions.ts` — viewed task, new-task overlay lane, CRUD/run adapters for it.
- `useTaskActions.ts` — composes `useTaskCrudActions` / `useTaskReorderActions` / `useTaskLifecycleActions` / `useTaskMergeActions` (also merge-all, cancel, `markAllQaDone`, `clearStuckConflicts` = `/merge-aborted` per orphaned conflict).
- `useTaskTerminals.ts` — composes `useTaskTerminalFocus` / `useTaskTerminalCleanup` / `useTaskTerminalReattach`.
- `usePostMergeHook.ts` — composes `usePostMergeHookForm` + `usePostMergeHookRun`; `usePostMergePromptDraft` is the row's draft.

State: `useTaskList.ts` (fetch + `/ws/tasks`, the shared `showError` toast
slot), `useTaskBoardState.ts` (grouping/sort/counts), `useTaskSearch.ts`,
`useTaskSelection.ts`, `useVisibleLanes.ts`, `useLaneSort.ts`,
`useSyncedViewedTask.ts`, `useTaskDetailEdit.ts`, `useHarnessSelector.ts` +
`harnessSelectorLoad.ts`.

Also: `useLaneDropTargets.ts`; `useBulkRunStrips.ts` + `useLaneBulkActions.ts`
(Open / In Progress / QA bulk strips + the per-lane `runAllActionByLane` map;
Ready-to-Merge uses `mergeAllReady` and the `useMergeRunSync` strip);
`useTaskSpawnHandler.ts`; `usePushRun.ts`, `useQaRuns.ts`, `useQaPlaywright.ts`;
`useVisibilityPolling.ts` (interval / hidden-pause / cancellation shell for push
+ QA polling); `optimisticSave.ts`, `strictSettingsLoad.ts`.

## Invariants

General:

- Hooks handed `addTerminal` type it as the shared `AddTerminal` from
  `terminal/terminalTypes.ts` — import it, don't redeclare it.
- Everything is project-fenced: the launcher stays mounted across project
  switches, so each hook drops/resets its per-project state on an
  `activeFolder` change and ignores results that land after one.
- Card props keep identity across content-unchanged board updates
  (`getFocusTerminal` built from `terminals` only; selection/drop callbacks read
  refs) — every `/ws/tasks` frame is a new array, and memoized cards would
  all re-render.

Task list, search, selection, reorder:

- `useTaskList` reports `[]` after a folder switch until the new folder's
  fetch/WS snapshot arrives (stale ids never actionable under the next project).
  A `partial` `/ws/tasks` update (the late-joiner replay) is ignored entirely:
  it neither replaces the board nor counts as live state that would drop the
  HTTP fetch.
- `useTaskList` structurally shares unchanged tasks and never mutates one in
  place — `useTaskSearch`'s per-Task `WeakMap` haystack cache depends on it. With
  search off, `filteredGrouped` is the caller's `grouped` itself, not a re-sort.
- Selection ranges run over the *filtered* grouping (shift-ranges skip hidden
  cards); a cross-lane range resets.
- Reorder slot indices count only visible cards: map them with
  `fullLaneDropIndex` (`../reorderMath.ts`) before splicing. A slot drop flips the
  lane to manual sort (`setManual`). Sort mode persists per project under
  `lattice.laneSort.<path>`.
- `useLaneDropTargets` hands every slot one stable `slotHandlers` set that reads
  `data-slot-index` (callbacks/hover via refs), so memoized `DropSlot`s
  re-render only when their `active` flag flips.
- `useTaskDetailEdit`: a task switch resets the draft; a same-id update
  reconciles per field against a baseline (`reconcileEditFields`) — untouched
  fields adopt the server value, edited ones keep the draft — and
  `computeSavePayload` sends only fields changed vs the current server task.
  Otherwise a stale local field clobbers a WS update on Save.
- `useHarnessSelector`: a folder switch starts from defaults; the load is
  strict (failed GET → `claude`, not `{}`) and guarded by a monotonic load id
  (`loadHarnessForFolder`) so A's late response can't overwrite B or persist
  under A. `selectHarness` claims a load id too, so a pick made mid-load wins
  (the in-flight GET would revert the dropdown while the new value stayed
  saved). Dropdown value: `pi:<provider/model>`.

CRUD and lifecycle:

- `addTask` / `editTask` / `deleteTask` resolve `false` after toasting, so the
  overlay stays open with the user's text. `addTask` runs `ensureGitRepo`
  BEFORE the POST (the backend refuses a non-git project at *create*); a
  decline returns false.
- `deleteTask` toasts a `keptBranch.hint` (unmerged commits) and still counts
  as success; a malformed field is ignored (`parseDeleteTaskResult`).
- Run/resume only enqueue: the terminal mounts later from `task-spawned`, never
  from the action. `runTask` re-checks `ensureGitRepo` (tasks filed over HTTP, a
  vanished `.git`); the provider coalesces per project so "run all" asks once.
  Run-all variants and `markAllQaDone` return the targeted ids for the strip.
- Retry policy: Run retries every transient failure (the backend dedupes a
  queued run) and treats a 400/409 after a possibly-applied attempt as its own
  run. Resume retries only recovery 503 / proxy ECONNREFUSED: a lost
  acknowledgement toasts "check the task terminal", because the spawn queue's
  dedupe key expires on settlement while the task stays In Progress — an
  automatic replay could allocate a second agent and replace the first one's
  tab.
- Bulk strips are keyed on `activeFolder`: a switch drops every record
  (during render) and clears every lane timer — else A's ids, absent from B's
  list, read as spawned and flash "Started N tasks" on B. Resume completes via
  `noteBulkSpawned`, bridged from the spawn handler through
  `setBulkSpawnNotifier` (the handler runs before the task list, the strips
  after); a safety timeout ends a strip that never completes.

Merge, resolvers and one terminal per task:

- `mergeTaskAction` on a conflict-flagged task with a live `kind: 'merge'` tab
  (`findLiveResolverTab`: has `serverId`, not exited/dead/restore-failed)
  focuses it and POSTs nothing — a second `/merge` spawns a second resolver
  into the same worktree. Only while `task.conflict`: a resolver that gave up
  leaves an idle session, and Merge must retry. A per-task in-flight ref makes a
  double-click one request; it retries only definitely-unaccepted failures.
- A conflict response without `serverId` means the backend's resolver
  pre-spawn failed: toast, never open the tab (a serverless `/ws/terminal`
  bypasses the spawn chokepoint — MCP scope, system prompt, registry).
- Every "replace this task's tab" close (`useTaskSpawnHandler`,
  `useMergeRunSync` on `conflict`, `mergeTaskAction`) calls
  `closeTerminalsForTask` with the just-delivered pty (`terminalId` +
  `serverId`) as `keep`: the registry's `upsert` usually mounts the fresh tab
  before the event arrives, and a plain per-task close DELETEs the agent that
  just started (killed queued runs, Resumes and merge-run resolvers). The close
  itself keeps one terminal per task per browser tab — a Resume re-spawns with
  a fresh serverId and cleanup never closes an in_progress tab.
- `useMergeRunSync` re-hydrates `/api/merge-runs/active` on every folder
  switch; a live WS event beats a late HTTP snapshot; each per-task error
  toasts once (bounded key sets); the error label fetches one task by id,
  never the whole board.
- `useTaskTerminalCleanup`: qa/done/deleted close every terminal of the task,
  resolvers included; ready_to_merge closes only the non-merge agent tab;
  in_progress is never closed. Closing and failed tabs are skipped (a failure
  waits for explicit retry); closes batch per task so one held DELETE can't
  delay another task's confirmation.
- `useTaskTerminalReattach` is a one-shot per project (fallback for a run
  admitted while no browser tab was open): it claims the one-shot only after a
  successful `/api/terminals` parse, retries with bounded backoff, skips tasks
  that already have a tab, and is keyed on the SET of reattachable tasks —
  keying on the task array restarted it every frame and polled forever. Its
  unregistered tab yields to the registry's record (`mergeRegistryTabs`).

Push, QA and settings-backed toggles:

- Push and QA pollers tear down (close terminal, forget the run) only on a
  real 404 or `done`; a thrown fetch is the `'error'` sentinel and is retried —
  collapsing it into "gone" kills the pty mid `git push` / strands a QA PASS
  verdict.
- `startPush` / `startQaRun` carry in-flight refs (Push disables only once the
  run is tracked and the backend doesn't dedupe it); a push start resolving
  after a project switch isn't tracked. One QA session per task: ▶ focuses the
  running session's tab; a run whose tab was closed no longer blocks.
- QA-run terminals carry NO `taskId` — cleanup closes every terminal tagged
  with a qa task's id and would kill them on spawn.
- `useQaPlaywright` / `usePostMergeHookForm` load with `loadUserSettingsWithRetry`
  (`fetchUserSettingsStrict`, retried until success or cancel): the lenient
  fetch maps a mid-restart 502 to `{}`, and a toggle then PATCHed defaults over
  the saved state. Controls stay disabled (row chip "Loading…") and saves no-op
  until `loaded`.
- Toggle/harness saves go through `saveOptimistic`: on failure revert to the
  last confirmed value, read at failure time, unless a later save or project
  switch superseded it (`isCurrent`, incl. A → B → A); a failed prompt save
  keeps the typed text. `qaPlaywright` is PATCHed whole, built from the LOADED
  value (the server merge is shallow), so flipping `enabled` keeps a saved
  `headless: false`.
- `usePostMergePromptDraft` debounces prompt saves (250 ms);
  `usePostMergeHookRun` lets live events supersede a late GET and restarts its
  subscription (resetting run state and spawned-run ids) when `activeFolder`
  or `addTerminal` changes.
