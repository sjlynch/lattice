# backend/src/routes/tasks

The task router, split by concern. `routes/tasks.ts` composes five
sub-routers (worktreeModified → activity → crud → run → hooks; the first two
register before crud so `GET /api/tasks/worktree-modified` isn't captured by
crud's `/api/tasks/:id`).

## Graph-overlay routes (`activity.ts` + `worktreeModified.ts`)

Both are read-only against the disposable worktree (plain `exec`, never
`projectGit`):

- `activity.ts` — `POST /api/tasks/:id/activity` (the Claude PreToolUse/
  PostToolUse hook → `notifyTaskActivity` → `task-activity` WS, for the focus
  beam). Owns the worktree→project path mapping and the exported `isManaged`
  filter, which `routes/agentActivity.ts` and `worktreeModifiedParsers.ts` both
  import.
- `worktreeModified.ts` — `GET /api/tasks/worktree-modified` (every file changed
  by an in_progress / ready_to_merge task, for the `W` highlight). Only wires the
  route; the git diff/status polling, per-project base-branch cache, and
  short-TTL result cache live in focused sibling modules (`worktreeModifiedService.ts`,
  `worktreeModifiedGit.ts`, `worktreeModifiedCache.ts`,
  `worktreeModifiedConstants.ts`, `worktreeModifiedParsers.ts`). Preserves the response
  shape, TTL, and git timeout behavior. Loads are single-flighted per project
  and probe at most 8 worktrees at once (two git processes each).

## CRUD (`crud.ts` builds the router; handlers split by concern)

`crud.ts` wires routes to handlers re-exported from `crudHandlers.ts`, which
is a **compatibility barrel** — it keeps the original import path stable
(`crud.ts` and `__tests__/projectScoping.test.ts` both import from it) while
the implementations live in focused modules:

- `crudList.ts` — `partitionByProject` + thin handlers for list / summary /
  search / projects / get. `partitionByProject` is the foreign-task integrity
  filter every project-scoped read runs; everything else here is an HTTP
  adapter over the two pure modules below.
- `listQuery.ts` — the pure progressive-disclosure pipeline behind
  `GET /api/tasks` and `/summary`. Holds `buildListOutcome` (the
  `LIST_RESPONSE_CEILING_BYTES` (256 KB) check that turns an oversized list
  into a 413 carrying the summary) and re-exports the stages, which live in
  flat siblings (deps: types ← parse/select/sizing ← envelope/summary ← outcome):
  - `listQueryTypes.ts` — shared constants (`ACTIVE_STATUSES`, limits, clip
    default) + `ParseResult` / `ListQuery` / `ListEnvelopeMeta`.
  - `listQueryParse.ts` — `status` CSV/`all` (ACTIVE-lanes default), `ids`,
    `fields`, `clip`, `since` (incl. `30d`/`12h`/`45m`), `limit`, `confirm_large`.
  - `listQuerySelect.ts` — `lastActivityAt`, filter + newest-first sort + page.
  - `listQuerySizing.ts` — `bytes`/`approxTokens`, compact projection, clipping.
  - `listQueryEnvelope.ts` — the teaching `hint` + self-pricing envelope.
  - `listQuerySummary.ts` — per-lane summary costing.

  **The defaults are the point** — the endpoint used to return every task, full
  text, uncapped (~320k tokens on a mature board), which is what every agent
  hit. `format=markdown` shares the whole pipeline except clipping: that doc
  round-trips through `/upsert`, which REPLACES descriptions, so a clipped
  round-trip would destroy task text.
- `taskSearch.ts` — the pure search behind `GET /api/tasks/search`: AND-of-terms
  substring match, title×3 scoring, the `…`-ellipsed snippet window, and its
  envelope. Defaults to EVERY lane (unlike the list) because history is where
  the interesting matches are. Registered before `/api/tasks/:id`, or `search`
  is captured as an id.
- `crudCreate.ts` — create / batch-create (JSON array, `{tasks}`, or markdown).
- `crudUpdate.ts` — thin patch / bulk-update / upsert / append-summary route
  handlers. The markdown-or-JSON body ergonomics (heredoc-friendly) are split
  into focused helpers: `crudUpdateBody.ts` (body normalization + block→patch),
  `crudUpdateValidation.ts` (bulk/upsert upfront validation), and
  `crudUpdateUpsert.ts` (project-scoped upsert application +
  `classifyUpsertTarget`).
- `crudTransition.ts` — bulk status transition (by `ids` or `fromStatus`
  lane) + per-lane reorder.
- `crudDelete.ts` — delete + cancel-queued-run; both clear spawn-queue state
  so a removed/cancelled task can't later spawn a worktree. Delete removes the
  worktree (uncommitted edits archived as always) but passes
  `keepBranchIfUnmerged`, so a `lattice/*` branch with commits not on HEAD —
  the only copy of that work — survives; the response then adds
  `keptBranch: {name, unmergedCommits, hint}` (`keptBranchPayload`), otherwise
  it stays `{ok: true}`. The MCP `delete_task` tool leads its result with the
  hint. Delete takes the **per-task `mergeLocks` lock** (after the project-pin
  check, before any side effect) and holds it across worktree teardown +
  record removal, so it can't pull a worktree out from under a live
  `git merge` or erase the record mid-finalize (which used to land the deleted
  work on main plus a "qa state could not be saved" run error). A held lock is
  waited for up to `TASK_DELETE_LOCK_WAIT_MS` (5 s, `mergeLocks.acquireBriefly`,
  shared with `/merge-aborted`), then answered **409** `{error, merging: true}`
  — the board toasts it. Deps seam `createTaskDeleteHandler({cleanupWorktree,
  lockWaitMs})` for the regression test.
- `crudTypes.ts` — shared `TaskIdRequest` type.

Keep the markdown/`text/plain` body handling intact — those routes use the
shared `textOrMarkdownBody` parser in `crud.ts`. Grammar (`markdownBatch.ts`):
a metadata-only heading (`# {id=t_1, status=done}`) is a valid heading with an
EMPTY title, which means "keep the title" on an update (PATCH / an id-bearing
upsert block) and is a 400 on a create. A markdown PATCH parses in
`singleTask` mode — only the first `#` heading is the title; later level-1
headings are description text rather than silently dropped extra tasks.
`serializeTasksAsMarkdown` backslash-escapes description lines that would read
as structure (`# ` headings, a fence that never closes) and the parser strips
one backslash outside fences, so GET `?format=markdown` → POST `/upsert` is a
no-op; a `limit`-capped listing carries `truncated=N/M` in its frontmatter.

## Run / merge routes (`run.ts` composes run → resume → merge)

- `runRoute.ts` — `POST /:id/run`: pin + `isFreshlyRunnable`, `enqueueTaskRun` → `{accepted, queued}`.
- `startTask.ts` — `startTaskById` (worktree → pty → in_progress flip), shared with the workflow Start step.
- `startWithdrawal.ts` — `startTaskById`'s withdrawal checks, withdrawn-start teardown (`discardOrphanedSpawn`) and CAP-parked checkouts.
- `colorSlot.ts` — `assignColorSlot` / `reserveColorSlot`: stable palette slot, reserved until the flip lands.
- `harnessFactory.ts` — `selectHarnessCommand`: harness → run/resume command + pty `createSession`.
- `mergeRoute.ts` — `POST /:id/merge`: 409 while a merge run / manual merge / post-merge hook is active.
- `manualMergeService.ts` — `runManualMerge`: project `run.lock`, fresh vs. already-conflicted, hook gate. Already-conflicted and still mid-merge: a live resolver pty in the worktree (`findExistingResolverSession`) is handed back (`respondLiveResolver`, `existingResolver: true`) instead of spawning a second one; an unreachable terminal-server falls through to the spawn.
- `mergeResponses.ts` — outcome → `{merged:true}`, a queued resolver pty, re-written `MERGE_INSTRUCTIONS.md`, or the already-running resolver (`respondLiveResolver`, instructions left untouched).
- `manualMergeGuards.ts` / `manualMergeLocks.ts` — per-project in-flight set; per-task `mergeLocks` wrapper.
- `manualMergeTypes.ts` — `MergeReadyTask` (a task with `branch` + `worktreePath`).
- `_shared.ts` — `requireTaskStatus` (400 on the wrong lane) + `logTaskRouteError`.
- `requestUtils.ts` — `respondJson`, project resolution/400s, project pins (`?project=`, else a JSON body's `project`; non-absolute → 400), status checks, `normalizeBody`.
- `projectValidation.ts` — `validateProjectForCreate`: creating needs an absolute path to a git repo.

## Queued spawns (`queuedSpawn.ts` barrel; split by concern)

`runRoute.ts` / `resumeRoute.ts` / `crudDelete.ts` / `recovery/queuedRunResume.ts`
and the `queuedSpawn.test.ts` suite import the queued-spawn surface from
`queuedSpawn.ts`, a **compatibility barrel** keeping that path stable while the
implementation lives in focused modules. Each queued thunk does the FULL spawn
(worktree + pty) and delivers its terminal over the `task-spawned` WS event; a
non-CAP failure emits `task-spawn-failed` instead. **Keep the crash-safe retry
semantics intact** — the attempt counter is bumped disk-first BEFORE the spawn
(`updateTaskCrashSafe`) so a process-crashing spawn still counts, a CAP re-queue
undoes that bump, and any other failure clears the run-queue state:

- `queuedSpawnAdmission.ts` — admission state: the `task-run:`/`task-resume:`
  dedupe keys, the persisted run-queue policy a run carries across a restart
  (and its `CLEARED_RUN_QUEUE_STATE` inverse), and the injectable
  `SpawnFailureDeps` failure-path I/O.
- `queuedSpawnFailure.ts` — the shared thunk body (`runSpawnThunk`): crash-safe
  at-admission attempt counting, CAP retry undo, and terminal-failure reporting
  (`reportSpawnFailure` → `task-spawn-failed`).
- `resumeTask.ts` — the resume spawn itself. **Harness default**: a body with
  no (valid) `harness` resumes under the harness the task was actually run
  with (`Task.harness`, recorded at spawn — `resolveResumeHarness`), and a Pi
  resume reuses the task's recorded `piModel` when none is given; only a task
  with no recorded harness falls back to Claude. An explicit harness in the
  body still wins, and the harness/model a resume actually spawned is written
  back onto the task so the switch sticks. (It used to default every
  body-less resume to Claude, silently moving Pi/Codex tasks onto Claude.)
- `queuedSpawnEnqueue.ts` — the run/resume enqueue wrappers (`enqueueTaskRun` /
  `enqueueTaskResume`) plus cancellation (`cancelQueuedTaskSpawns` /
  `dequeueTaskRun`). Cancellation also reaches a run the queue already
  admitted: its request signal is aborted (`cancel-queued-run` then answers
  `inFlight: true`).
- `startTask.ts` — the run spawn itself. **A cancel / delete / lane change
  made while a start is in flight wins**: `startTaskById` re-checks after the
  checkout, before a CAP re-queue, and at the final `in_progress` flip — that
  one a compare-and-set under the task lock (`updateTaskWith`). A withdrawn
  start tears down its worktree + pty (keeping a checkout another start of the
  task already claimed) and throws `TaskStartWithdrawnError`
  (`queuedSpawnAdmission.ts`; `runSpawnThunk` neither toasts it nor touches the
  run-queue state) or, for a deleted task, a plain Error. A CAP-rejected
  pass parks a teardown on the request signal, so a cancel before the retry
  still reclaims its checkout. The palette slot is picked inside that same
  flip: the stored `colorIndex` is kept only while no other active task or
  reservation holds it (`colorSlot.ts` `reserveColorSlot(…, preferred)`).
  **At most one start per task at a time, whatever the entry point (do not
  regress)**: a task stays `open` until the flip, so the workflow Start step's
  direct start and a `/run` admitted during its minutes-long checkout both
  passed `isFreshlyRunnable` — the second setup's reconcile killed the first
  agent and stranded the task In Progress with no pty. An in-process
  per-task chain (`startsInFlight`, `isTaskStartInFlight`) makes a concurrent
  second start wait for the first, then withdraw (`checkWithdrawal`) if the
  task was claimed, or run as an ordinary retry if the first failed. Covered
  by `__tests__/startTaskConcurrent.test.ts`.

## Worktree lifecycle hooks (`hooks/`)

Idempotent Stop-hook / resolver callbacks. `hooks/index.ts`'s
`buildTaskHookRouter` assembles the router; one handler module per route:

- `hooks/complete.ts` — `/complete`. Two sub-branches: resolver-finished
  (ready_to_merge + conflict → `finalizeResolvedTask`) and the original
  in_progress → ready_to_merge flip (**only** with a branch commit; kills the
  idle pty after responding).
- `hooks/merged.ts` — `/merged`. Resolver success → `finalizeResolvedTask`,
  but **only while `task.conflict` is still set** (same gate `/complete`'s
  resolver branch uses). A late `/merged` from a resolver abandoned by
  `/merge-aborted` (the Cancel button cleared the flag) is a harmless no-op
  rather than a silent finalize + main fast-forward.
- `hooks/mergeAborted.ts` — `/merge-aborted`. Honours the project pin
  (`requireTaskInRequestedProject`: a task from another board is a 404 and
  nothing is aborted); a missing/empty project is unpinned, so the resolver
  agent's give-up curl keeps working. Delegates the abort-mid-merge +
  clear-conflict-flags (what makes a Cancel authoritative — see `/merged`'s guard
  above) + kill-orphaned-resolver-pty to the shared
  `mergeRuns/abandonedResolver.ts` `recoverAbandonedResolverTask`, **then**
  `signalConflictWaiter(task.id)` to release any merge-run worker parked on this
  task's untimed conflict waiter (else the run awaits forever, holding the
  project run-lock → later merges 409). The aborted task is left at plain
  ready_to_merge to retry on the next merge-all (no auto-restart, unlike
  /complete + /merged). Runs the recovery **under the per-task `mergeLocks`
  lock** (`git merge --abort` mutates the worktree index, like every other
  in-worktree git mutation that takes it), so a Cancel can't race a live
  `git merge` on the same index. A held lock is WAITED for (up to
  `MERGE_ABORT_LOCK_WAIT_MS`, 5 s — the run's conflict wait parks lock-free,
  so the lock is only held for the seconds a merge/finalize takes, and a
  resolver Claude's give-up curl is one-shot and cannot retry) and only then
  answered **409**. Has an injectable deps seam (`recover` +
  `signalConflictWaiter` + `lockWaitMs`) mirroring `finalizeResolved.ts` for
  the parked-run regression test.
- `hooks/stashResolved.ts` — `/stash-resolved`. Cleanup → qa, then
  auto-restart the merge run for remaining work.
- `hooks/postMergeHookHelper.ts` — `awaitPostMergeHookOutsideRun`, shared by
  complete / merged / stash-resolved. Skips the gate when a merge run is
  active (the run owns its own end-of-run hook fire; double-firing deadlocks).

The resolver-finished `/complete` branch and `/merged` share the
"re-sync with main, finalize, requeue on conflict" flow in
`routes/tasks/finalizeResolved.ts`; each route only renders the discriminated result
into its own HTTP shape. `finalizeResolvedTask` takes the per-task
`mergeLocks` lock around its git work, so it serializes against the merge-run
worker (`mergeRuns/processTarget.ts` + `tryFinalizeAfterResolverFinished`,
which take the same lock) and against a duplicate hook fire (two near-
simultaneous `/complete` curls, or `/complete` racing `/merged`) — otherwise
two `mergeWorktreeInRepo` runs race on `.git/index.lock` + `MERGE_HEAD` in the
one worktree. A caller that loses the race gets the `already-finalizing` result
(rendered as `{ok:true, finalizing:true}`); the callbacks are idempotent, so the
lock holder finishes the work. Once it HAS the lock it re-reads the task
(`deps.readTask`, default `getTask`) and returns the same no-op if `conflict`
was cleared meanwhile — the route checked the flag before the lock, and a
Cancel landing in that window used to be overridden by a FF into main. (The `finalizeQueues` promise queue only
serializes the FF step, not this earlier in-worktree merge.)

This back-off is correct ONLY because the lock holder is actively *doing* the
git work. The merge-run worker therefore must NOT hold the lock while merely
*parked* on a conflict waiter: it drops it before waiting
(`mergeRuns/resolverSpawn.ts` `parkOnConflictResolver`). The resolver's
Stop-hook `/complete` is the thing that finalizes + signals that waiter, and it
needs the same per-task lock to do so — if the parked worker still held it,
`/complete` would back off with `already-finalizing` and never signal, hanging
the run forever (and leaving the resolver pty alive, since only the finalize's
worktree cleanup tears it down).

## Stability

Route paths, methods, status codes, response shapes, and idempotency are part
of the public contract (worktree Stop hooks / resolver curls depend on them) —
don't change them when refactoring these modules.
