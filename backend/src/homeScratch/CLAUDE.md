# backend/src/homeScratch

The **canonical home-scoped-scratch contract** shared by the one-off
agent run-types — `pushRuns/`, `qaRuns/`, and `postMergeHooks/`. Each of those
spawns a throwaway Claude/Pi session in a per-run scratch dir under
`~/.lattice/per-project/<hash>/<dir>/<id>/` (OUTSIDE the repo on purpose), and
each used to carry its own near-identical copy of the path-safety guard, the
session-setup lifecycle, and the bounded recursive cleanup. This module is the
single source of truth for all three.

## Files

- `paths.ts` — `createHomeScratchPaths({dirName, idPrefix, logLabel, noun})`
  returns the per-feature path helpers: `createSessionId` (`<idPrefix>_<ts>_<hex>`),
  `sessionsRoot` / `sessionDir`, and **`assertSafeSessionPath`** — the
  `.git`-deletion path guard. It refuses any id that fails the id regex, any dir
  not strictly under the home scratch root, or any dir that lands inside the
  project repo. Also exports the pure primitives (`safeRelative`,
  `isPathInsideOrSame`, `isPathStrictlyInside`). **This guard is part of the
  repo's `.git`-deletion defence layer (see the root `CLAUDE.md`) — it is what
  bounds the recursive cleanup so it can never reach `.git`. Do not weaken it.**
- `session.ts` — the shared session-setup builder:
  - `setupHomeScratchSession(...)` — materialize one scratch dir: mint+verify
    id → mkdir → `seedClaudeTrust` → `installHooks` (feature callback) →
    render+write the instruction brief (`renderInstructions` feature callback).
    Used by push, QA, **and** post-merge.
  - `startHomeScratchAgentSession(...)` — the full spawn: `setupHomeScratchSession`
    → `buildCommand` → `queuedCreateSession` → on error run `cleanup` + rethrow,
    on success `onSpawned` (record run + register the orange presence node).
    Used by push + QA, whose flows are exact mirrors. Post-merge keeps its own
    trigger/gate/waiter (`postMergeHooks/trigger.ts`) but reuses the materialize
    half.
- `agentSession.ts` — `createHomeScratchAgentSession(spec)`: the push/QA mirror
  factory layered on `startHomeScratchAgentSession`. From a static per-run-type
  `spec` (paths, instructions filename, fixed command, queue kind / dedupe
  prefix, `isQaRun?`, presence `agentId`/`label`, cleanup) it returns a `start(args)`
  function that drives one spawn and folds in the boilerplate both run-types
  shared verbatim — the command wrapper, the `interactive` queue band, and the
  orange-presence `registerAgentSession` call. The genuinely per-run-type pieces
  stay explicit as `args`: `installHooks`, `renderInstructions`, and `recordRun`
  (the feature's registry write). Push/QA `session.ts` are thin adapters over
  this; post-merge does **not** use it (no presence node / registry of this
  shape). New shared spawn boilerplate goes here, not in the per-feature dirs.
- `cleanup.ts` — `cleanupHomeScratchSession({paths, projectPath, id, logLabel})`:
  the bounded recursive scratch delete (kill the PTY holding the dir handle →
  `notifySessionsFreed` → strip reparse points → `fsRmWithRetries`), gated
  through the feature's `assertSafeSessionPath` + `assertNotReparsePoint`. On
  failure it leaves the dir for the boot sweep. Used by push, QA, and
  post-merge hook cleanup wrappers.
- `registry.ts` — `createOneOffRunRegistry(...)`: the tiny shared in-memory
  lifecycle for push + QA (`record`, guarded `forget` that preserves running
  runs, `markDone` stamping `doneAt`, optional event fan-out). QA-specific
  verdict fields and push-specific subscriptions remain in their feature
  registries.
- `routes.ts` — small idempotent `{ok:true}` response shells for scratch-backed
  `/done` and frontend-acknowledgement `DELETE` routes. Route-specific behavior
  stays in the route files.
- `sweep.ts` — shared boot sweep for scratch roots: collect live terminal cwd
  roots once, iterate known projects' scratch dirs, skip dirs with live PTYs,
  and delegate id/root validation + deletion to the feature cleanup wrapper.

## Per-feature config

Each run-type's `paths.ts` calls `createHomeScratchPaths` once and re-exports
its methods under the legacy names, so all existing import paths keep working:

| feature        | dirName             | idPrefix | logLabel             | noun           |
|----------------|---------------------|----------|----------------------|----------------|
| pushRuns       | `push`              | `push`   | `[pushRuns]`         | `push session` |
| qaRuns         | `qa`                | `qa`     | `[qaRuns]`           | `qa session`   |
| postMergeHooks | `post-merge-hooks`  | `pmh`    | `[post-merge-hook]`  | `hook`         |

## Adding a fourth run-type

Call `createHomeScratchPaths(...)` in a feature `paths.ts`, drive setup/spawn
through `startHomeScratchAgentSession` (or `setupHomeScratchSession` if you need
a bespoke spawn flow), and add a boot sweep that reclaims orphans under your
scratch root (`recovery/`). Do **not** hand-roll the path guard or the recursive
delete — they are the `.git`-deletion defence and must stay centralized here.
