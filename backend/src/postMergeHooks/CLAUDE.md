# backend/src/postMergeHooks

Optional per-project **post-merge hook**: after a merge (per-task `/merge` or a "Merge All" run), Lattice spawns the user-configured harness with their prompt as a one-off task, and the merge is **not** considered complete until that agent calls back. This keeps any workflow merge step / per-task merge response gated on the post-merge agent finishing. Parallels the `pushRuns/` subsystem — same scratch-dir + Stop-hook + registry-waiter shape. `../postMergeHooks.ts` is the public shim.

## Shared scratch contract (`../homeScratch/`)

The home-scoped scratch path guard, session-setup lifecycle, bounded cleanup, and boot-sweep shell are shared with pushRuns / qaRuns via **`backend/src/homeScratch/`**. `paths.ts` is one `createHomeScratchPaths(...)` call (`post-merge-hooks`/`pmh`/`[post-merge-hook]`/`hook`), and `sessionSetup.ts` materializes the scratch dir through `setupHomeScratchSession`. Post-merge keeps its **own** trigger/gate/waiter (`trigger.ts` + `session.ts`) rather than the push/QA `startHomeScratchAgentSession` spawn helper — it records the run *before* spawn (so the waiter is in place), registers the presence node only for Claude, and on spawn failure marks the run `errored` instead of throwing. `cleanup.ts` wraps the shared guarded delete, and startup recovery runs `sweepOrphanedPostMergeHookSessions` for stale `pmh_*` dirs while preserving live PTY cwd roots.

## Flow

- `trigger.ts` — `triggerPostMergeHook`, the decide-and-outcome half: gate on empty prompt (`no-prompt` skip), the master enable toggle (`disabled` skip when `postMergeHookEnabled === false`, even with a prompt — `isPostMergeHookEnabled` defaults ON), and one-running-per-project (`already-running` skip via `getActiveHookForProject`), record the run, spawn the pty (spawn-queue `priority` band, deduped per project), and register the orange agent-session node (Claude only). Returns an outcome immediately; callers block via the waiter.
- `session.ts` — `runPostMergeHookGate`, the thin trigger + `waitForPostMergeHook` coordinator. The merge-run finisher / per-task finalize `await` this so the merge stays gated until the hook reaches a terminal status.

## Who waits for a hook (and the gap that isn't obvious)

Two *different* callers gate on a hook, and only one of them covers workflows:

- **Inside a merge run** — `mergeRuns.ts` awaits `runPostMergeHook` **before** `finishRun`, so the run's `completed` event (and therefore a workflow Merge step parked in `waitForMergeRunFinished`) already waits it out. Preserve that ordering.
- **Outside a merge run** — `routes/tasks/hooks/postMergeHookHelper.ts`'s `awaitPostMergeHookOutsideRun` (the resolver `/complete` branch, `/merged`, `/stash-resolved`) fires a hook exactly when **no** merge run is active, so no `finishRun` gates it. It's awaited only by the HTTP callback that triggered it — *not* by any workflow run.

That second case is why the workflow Merge step has its own **Phase C** gate (`workflowRuns/controlSteps/merge.ts`): without it the step reported `merge complete`, the workflow run finished, and the frontend queue — which only tracks workflow runs — started the next queued workflow's step 1 alongside the still-running hook agent. If you add a new hook-firing path, it must either be inside a merge run or be visible to `getActiveHookForProject` while it runs (Phase C polls that), never a fire-and-forget spawn.
- `sessionSetup.ts` — the filesystem/trust half: mkdir the scratch dir, `seedClaudeTrust` (trust-only), install the completion plumbing, render the brief. Mirrors `pushRuns/session.ts`.
- `paths.ts` — scratch lives at `~/.lattice/per-project/<hash>/post-merge-hooks/<id>/` (home-scoped, **outside** the repo). `assertSafePostMergeHookPath` refuses any id/dir not strictly under that root or that lands inside the project, so the bounded recursive cleanup can never reach the repo.
- `stopHook.ts` — installs **both** the Claude Stop hook and the Pi completion extension into the scratch dir regardless of harness (defence-in-depth against a mid-run harness switch); the unused one is inert. Codex has no backstop and must curl the callback explicitly. Also defines `postMergeHookAgentId` and the activity-hook URL for the graph beams.
- `commands.ts` / `instructions.ts` — the launch command and the `POST_MERGE_HOOK.md` brief. **Key invariant:** the pty runs with `cwd = scratchDir` (so Claude reads the Stop hook from cwd and Pi loads `.pi/extensions/` from cwd); the brief's step 1 then `cd`s the agent into the project. Running with `cwd = projectPath` was the original bug — the Stop hook never fired and the merge run hung forever. Don't reintroduce it.
- `registry.ts` — in-memory run registry (one running per project, last ~5 finished kept), the `started`/`progress`/`finished` event fan-out for the UI, and the per-run promise waiters that the `/complete` + `/abort` routes resolve.
- `cleanup.ts` — post-merge hook wrapper over `homeScratch/cleanup.ts`; called from `/complete`, `/abort`, queued spawn failure, and the boot sweep.
- `types.ts` — `PostMergeHookRun` / `PostMergeHookSession` / `PostMergeHookStatus`.
