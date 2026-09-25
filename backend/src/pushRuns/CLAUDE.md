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
persisted-registry / home-scoped-scratch / path-guard / Stop-hook / boot-sweep
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
  shared `homeScratch/` builders: `startPushSession` goes through the
  `createHomeScratchAgentSession(spec)` mirror factory (which owns the command,
  `interactive` queue band, presence-node registration, and cleanup wiring);
  `setupPushSession` is the materialize-only `setupHomeScratchSession`. Only the
  push-specific brief, hook install, and registry record (`recordPushRun`) stay
  here — passed to the factory's `start` per call. `qaRuns/session.ts` is the
  exact mirror (its `spec` adds `isQaRun: true`).
- `stopHook.ts` — installs the Claude Stop hook (→ `/api/push-runs/:id/done`) +
  activity hook; defines the stable `pushAgentId`.
- `instructions.ts` — renders `PUSH_INSTRUCTIONS.md` from the editable `push`
  instruction template.
- `registry.ts` — the in-memory run map (+ lifecycle event fan-out) whose
  **running** runs are mirrored to `~/.lattice/per-project/<hash>/push-runs.json`
  (`pushRunStore`, `../homeScratch/persistence.ts`). The push agent's pty
  survives a backend restart in the detached terminal-server, so boot recovery
  (`recovery/oneOffRunResume.ts`) puts back a run whose pty is still alive —
  its `/done` then lands normally instead of 404ing — and settles one whose pty
  is gone (`markPushRunLost`: `lost` + done) after a grace for the callback
  outbox. A run records its `serverId` and, when a workflow Push step spawned
  it, `workflowRunId` + `workflowStepIndex`: `findRunningPushRunForWorkflowStep`
  is how a Push step re-dispatched after a restart attaches to that session
  instead of pushing a second time (a `lost` run is never attachable).
  `forgetPushRun` evicts a finished run.
- `types.ts` — `PushRun` / `PushSession`.

## Scratch

`~/.lattice/per-project/<sha1(path)[:12]>/push/<id>/` — home-scoped,
**outside** the repo on purpose so the recursive cleanup can never reach the
project tree. At boot, a dir whose pty did not survive is swept
(`recovery/pushSessionSweep.ts`); a live one belongs to a re-adopted run.
