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
  filter, which `routes/agentActivity.ts` and `worktreeModified.ts` both import.
- `worktreeModified.ts` — `GET /api/tasks/worktree-modified` (every file changed
  by an in_progress / ready_to_merge task, for the `W` highlight). Owns the git
  diff/status polling, the per-project base-branch cache, and the short-TTL
  result cache. Preserves the response shape, TTL, and git timeout behavior.

## CRUD (`crud.ts` builds the router; handlers split by concern)

`crud.ts` wires routes to handlers re-exported from `crudHandlers.ts`, which
is a **compatibility barrel** — it keeps the original import path stable
(`crud.ts` and `__tests__/projectScoping.test.ts` both import from it) while
the implementations live in focused modules:

- `crudList.ts` — `partitionByProject` + list / summary / projects / get.
  `partitionByProject` is the foreign-task integrity filter every
  project-scoped read runs.
- `crudCreate.ts` — create / batch-create (JSON array, `{tasks}`, or markdown).
- `crudUpdate.ts` — patch / bulk-update / upsert / append-summary. The
  markdown-or-JSON body ergonomics (heredoc-friendly) live here.
- `crudTransition.ts` — bulk status transition (by `ids` or `fromStatus`
  lane) + per-lane reorder.
- `crudDelete.ts` — delete + cancel-queued-run; both clear spawn-queue state
  so a removed/cancelled task can't later spawn a worktree.
- `crudTypes.ts` — shared `TaskIdRequest` type.

Keep the markdown/`text/plain` body handling intact — those routes use the
shared `textOrMarkdownBody` parser in `crud.ts`.

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
- `hooks/mergeAborted.ts` — `/merge-aborted`. Aborts a lingering mid-merge,
  clears the conflict flags (which is what makes a Cancel authoritative —
  see `/merged`'s guard above), and kills the orphaned resolver pty by
  worktree cwd so it stops working on the abandoned resolution.
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
lock holder finishes the work. (The `finalizeQueues` promise queue only
serializes the FF step, not this earlier in-worktree merge.)

## Stability

Route paths, methods, status codes, response shapes, and idempotency are part
of the public contract (worktree Stop hooks / resolver curls depend on them) —
don't change them when refactoring these modules.
