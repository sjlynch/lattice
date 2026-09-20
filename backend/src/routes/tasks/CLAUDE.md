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
  `…Git.ts`, `…Cache.ts`, `…Constants.ts`, `…Parsers.ts`). Preserves the response
  shape, TTL, and git timeout behavior.

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
  `GET /api/tasks` and `/summary`: query parsing (`status` CSV/`all` with the
  ACTIVE-lanes default, `ids`, `fields`, `clip`, `since` incl. `30d`/`12h`/`45m`
  durations, `limit`, `confirm_large`), `lastActivityAt`, filter + newest-first
  sort, the compact projection, text clipping, the teaching `hint`,
  `bytes`/`approxTokens` self-pricing, the per-lane summary costing, and the
  `LIST_RESPONSE_CEILING_BYTES` (256 KB) check that turns an oversized list into
  a 413 carrying the summary. **The defaults are the point** — the endpoint used
  to return every task, full text, uncapped (~320k tokens on a mature board),
  which is what every agent hit. `format=markdown` shares the whole pipeline
  except clipping: that doc round-trips through `/upsert`, which REPLACES
  descriptions, so a clipped round-trip would destroy task text.
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
  so a removed/cancelled task can't later spawn a worktree.
- `crudTypes.ts` — shared `TaskIdRequest` type.

Keep the markdown/`text/plain` body handling intact — those routes use the
shared `textOrMarkdownBody` parser in `crud.ts`.

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
- `queuedSpawnEnqueue.ts` — the run/resume enqueue wrappers (`enqueueTaskRun` /
  `enqueueTaskResume`) plus cancellation (`cancelQueuedTaskSpawns` /
  `dequeueTaskRun`).

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
- `hooks/mergeAborted.ts` — `/merge-aborted`. Delegates the abort-mid-merge +
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
`../finalizeResolved.ts`; each route only renders the discriminated result
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
