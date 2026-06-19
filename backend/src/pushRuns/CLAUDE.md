# backend/src/pushRuns

One-off Claude sessions for the QA-lane **Push** button (and the workflow Push
control step): spawn a Claude in throwaway scratch that `cd`s into the project
and commits/pushes per the `PUSH_INSTRUCTIONS.md` brief, then calls back on
Stop. `../pushRuns.ts` is the public shim; served by `routes/pushRuns.ts`
(`/api/push-runs`).

## Mirror contract

`qaRuns/` is a near-clone of this directory — same skeleton, same
in-memory-registry / home-scoped-scratch / path-guard / Stop-hook / boot-sweep
contract. **Edit one and the other almost always changes in lockstep.** The
only structural divergence is qaRuns' extra `verdict.ts` (qa → done
auto-promotion), which pushRuns has no equivalent for. Keep the differences
cosmetic: the `[pushRuns]`/`[qaRuns]` log prefixes and the `push`/`qa` id-prefix
+ scratch dirname. A future third run-type should clone this skeleton
wholesale — **including** the path guards below, which are part of the repo's
`.git`-deletion defence layer (see the root `CLAUDE.md`).

## Files (the shared skeleton)

- `paths.ts` — id minting (`push_<ts>_<hex>`), scratch path helpers, and the
  **path-safety guards**: `assertSafePushSessionPath` refuses any id that fails
  the id regex, any dir not strictly under the home scratch root, or any dir
  that lands inside the project repo (`isPathInsideOrSame`). This is what bounds
  the recursive cleanup so it can never reach `.git`.
- `cleanup.ts` — the bounded recursive scratch delete: kill the PTY holding the
  dir handle, strip reparse points, then `fsRmWithRetries` (Windows
  EBUSY/EPERM). Gated through `assertSafePushSessionPath` + `assertNotReparsePoint`;
  on failure it leaves the dir for the boot sweep rather than forcing the delete.
- `session.ts` — `startPushSession`: mkdir scratch, `seedClaudeTrust`, install
  the Stop hook, render the brief, spawn the pty via `queuedCreateSession`
  (`cwd = scratch` so Claude reads the Stop hook from cwd; the brief `cd`s into
  the project), record the run, register the orange agent-session graph node.
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
