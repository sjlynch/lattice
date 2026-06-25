# backend/src/pushRuns

One-off Claude sessions for the QA-lane **Push** button (and the workflow Push
control step): spawn a Claude in throwaway scratch that `cd`s into the project
and commits/pushes per the `PUSH_INSTRUCTIONS.md` brief, then calls back on
Stop. `../pushRuns.ts` is the public shim; served by `routes/pushRuns.ts`
(`/api/push-runs`).

## Shared contract (`../homeScratch/`)

The path guard, session-setup lifecycle, and bounded recursive cleanup are no
longer hand-rolled here — they live in **`backend/src/homeScratch/`**, the
canonical home-scoped-scratch contract shared by pushRuns / qaRuns /
postMergeHooks. This dir's `paths.ts` / `session.ts` / `cleanup.ts` are now thin
wrappers that pass the `push`/`[pushRuns]`/`push session` config into that
factory. **A change to the path guard or cleanup goes in `homeScratch/`, not
here.**

## Mirror contract

`qaRuns/` is a near-clone of this directory — same skeleton, same
in-memory-registry / home-scoped-scratch / path-guard / Stop-hook / boot-sweep
contract (now backed by the shared `../homeScratch/` builder).
**Edit one and the other almost always changes in lockstep.** The
only structural divergence is qaRuns' extra `verdict.ts` (qa → done
auto-promotion), which pushRuns has no equivalent for. Keep the differences
cosmetic: the `[pushRuns]`/`[qaRuns]` log prefixes and the `push`/`qa` id-prefix
+ scratch dirname (the four `createHomeScratchPaths` fields). A future third
run-type should reuse `../homeScratch/` the same way — **including** the path
guard, which is part of the repo's `.git`-deletion defence layer (see the root
`CLAUDE.md`).

## Files (the shared skeleton)

- `paths.ts` — one `createHomeScratchPaths(...)` call wired with the
  `push`/`[pushRuns]`/`push session` config; re-exports `createPushSessionId`,
  `pushSessionsRoot`, `pushSessionDir`, `assertSafePushSessionPath`, plus the
  `pushPaths` object the builder consumes. The **path-safety guard** itself lives
  in `../homeScratch/paths.ts`: it refuses any id that fails the id regex, any
  dir not strictly under the home scratch root, or any dir that lands inside the
  project repo — what bounds the recursive cleanup so it can never reach `.git`.
- `cleanup.ts` — thin wrapper over `cleanupHomeScratchSession` (the shared
  bounded recursive delete: kill the PTY holding the dir handle, strip reparse
  points, then `fsRmWithRetries` for Windows EBUSY/EPERM, gated through
  `assertSafePushSessionPath` + `assertNotReparsePoint`). On failure it leaves
  the dir for the boot sweep rather than forcing the delete.
- `session.ts` — `startPushSession` / `setupPushSession`, thin wrappers over the
  shared `startHomeScratchAgentSession` / `setupHomeScratchSession` builder:
  mkdir scratch, `seedClaudeTrust`, install the Stop hook, render the brief,
  spawn the pty via `queuedCreateSession` (`cwd = scratch` so Claude reads the
  Stop hook from cwd; the brief `cd`s into the project), record the run, register
  the orange agent-session graph node. Only the push-specific brief, command, and
  registry calls stay here.
- `stopHook.ts` — installs the Claude Stop hook (→ `/api/push-runs/:id/done`) +
  activity hook; defines the stable `pushAgentId`.
- `instructions.ts` — renders `PUSH_INSTRUCTIONS.md` from the editable `push`
  instruction template.
- `registry.ts` — the **in-memory, non-persisted** run map (+ lifecycle event
  fan-out). At boot it's empty, so any scratch dir still on disk is by
  definition stale and is reclaimed by `recovery/pushSessionSweep.ts`
  (`sweepOrphanedPushSessions`). `forgetPushRun` evicts a finished run.
- `types.ts` — `PushRun` / `PushSession`.

## Scratch

`~/.lattice/per-project/<sha1(path)[:12]>/push/<id>/` — home-scoped,
**outside** the repo on purpose so the recursive cleanup can never reach the
project tree. Non-persisted registry ⇒ stale-at-boot ⇒ swept.
