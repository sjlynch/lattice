# backend/src/projectRunLock

Cross-process exclusion for repo-mutating runs — **defence layer #8** in the
root `CLAUDE.md`'s `.git`-deletion defences. The in-process guards (the
`mergeRuns.ts` singleton, `mergeLocks.ts`) only stop races *within one*
Lattice process; this stops two Lattice processes (the classic case: Lattice
opened on its own repo while another instance has the same repo as a project)
from entering the merge pipeline at once and racing on `git status` /
snapshot / fast-forward. `../projectRunLock.ts` is the public facade.

## What it guards

One lockfile per project: `~/.lattice/per-project/<hash>/run.lock`, resolved by
`paths.ts` through `homeProjectDir(projectPath)` and the shared `projectHash`
contract in `../projectPath.ts`. Path aliases must share the preserved storage
hash so they contend for the same lock; do not recompute a hash from a path
spelling. See [project identity and legacy storage](../PROJECT_IDENTITY.md).

Body is `{pid, hostname, startedAt, label, ownerId}`. The UUID `ownerId` is
minted per acquisition and identifies its generation; legacy locks lack it.
The lock covers the duration of merge runs (`merge-run`), manual merges
(`manual-merge`) and the mutation/exclusive holds below. Labels identify the
operation for diagnostics, recovery and restart deferral.

## Lifecycle

`acquire → (steal if stale) → release`, almost always via the
`withProjectRunLock(projectPath, label, fn)` wrapper (acquire, run `fn`,
release in `finally`).

- **Acquire:** `acquireProjectRunLock` waits while a restart drain is active
  (`../restartDrain/gate.ts`; the drain expires by TTL if no restart follows).
  `writeNewLockBody` writes the complete body to a unique sibling with `wx`,
  then atomically publishes `run.lock` with exclusive `fs.link(pending, file)`;
  sibling cleanup is best-effort in `finally`. The hard link is the
  mutual-exclusion primitive. A direct asynchronous `wx` write to `run.lock`
  exposes an empty body that a contender could misclassify as corrupt and
  steal. Unsupported hard-link filesystems fail acquisition; never fall back
  to partial-body publication. On `EEXIST`, `clearStaleLockOrThrow` attempts
  stale retirement or refuses; acquisition makes at most two publication
  attempts, then surfaces an error rather than spinning.
- **Retire:** release first checks `sameLockBody` (including `ownerId`); stale
  recovery first applies the liveness rules below. Both use `retireLockFile`,
  which must claim `run.lock.retired/<sha256(exact raw body)>` with `wx`, then
  re-read and match the exact raw body before unlinking `run.lock`. The claim
  allows only one observer to remove that generation, protecting a successor
  from a suspended stale observer; a body comparison alone is insufficient.
  Hashing the original bytes also distinguishes legacy generations.
  `readLockObservation` treats only `ENOENT` as absence; other read errors
  propagate and refuse release/recovery.

Keep retirement tombstones (tiny audit records): deleting them while a process
can retain an observation reintroduces the race. The bounded exception is
`pruneRetiredTombstones`, called through `pruneRetiredTombstonesOnce` on the first
acquisition per project per process. It proceeds only when `run.lock` is absent
and removes tombstones older than 7 days (`at` in the body, mtime fallback);
ones whose age cannot be judged are kept. This relies on generation bodies
never being re-issued (UUID `ownerId` + timestamp); do not broaden the pruning.

A crash after claiming retirement but before unlink deliberately leaves the
old lock blocked. The recovery diagnostic requires stopping all backends
before inspecting/removing only `run.lock`, preserving `run.lock.retired`.
This is a fail-closed availability limit, not automatic crash recovery.
Concurrent older backends that ignore tombstones are unsupported; upgrade all
backends together.

`inspectProjectRunLock` reads `{holder, alive}` without acquiring or stealing —
used by recovery's merge-run resume to spot an interrupted run and by the dev
runner to decide whether to defer a restart.

## Liveness / staleness model

A lock is stealable when its holder is provably gone. `clearStaleLockOrThrow`
steals on: unparseable lockfile; or same-host holder whose PID is dead. It
**refuses** (throws `ProjectRunLockedError`) on: a live same-host holder; a
remote-host holder (we can't probe a remote PID, so conservatively assume
alive); and same-process re-entry (would deadlock the merge worker — the
in-process guards are meant to catch this first).

The subtle part is PID reuse (aggressive on Windows). `isLockHolderAlive`
isn't just `process.kill(pid, 0)`:
- If the holder's PID equals ours but its `startedAt` predates *this*
  process's start, it's a stale lock from a prior backend that happened to
  get our PID — treated as dead so we steal it. (`isCurrentProcessHolder`
  encodes the same check for the re-entry refusal.)
- If the PID is live but the OS-reported process start time is *after* the
  lock's `startedAt`, the PID was recycled into an unrelated process and the
  real holder is gone — steal. (`getProcessStartTimeMs`: PowerShell on
  win32, `ps -o lstart=` on POSIX; `null`/uncertain ⇒ assume alive.)

`THIS_PROCESS_STARTED_AT` (captured once at load from `process.uptime()`)
and `PROCESS_START_FUZZ_MS` (1 s slack) drive both checks. Without this, a
stale `merge-run` lock left by a crashed backend stays un-stealable forever
and silently aborts every later run on that project.

## Modules

| File | Owns |
|------|------|
| `paths.ts` | Lockfile path (`run.lock` under `homeProjectDir`). |
| `types.ts` | `LockBody`, `ProjectRunLockHandle`, `ProjectRunLockInspection`. |
| `lockfile.ts` | Read/parse observations, complete-body hard-link publication, retirement claims + `sameLockBody`. |
| `tombstones.ts` | `pruneRetiredTombstones` — the bounded, lock-absent-only 7-day prune of `run.lock.retired/`, run once per project per process from `acquire.ts`. |
| `liveness.ts` | `currentLockBody`, PID-alive probe, PID-reuse disambiguation. |
| `steal.ts` | `clearStaleLockOrThrow` — decide steal vs. throw. |
| `acquire.ts` | `acquireProjectRunLock` — restart-drain gate, pruning, publication + one stale-recovery retry. |
| `ownership.ts` | `Owner`, the single canonical-project local registry, its internal live-owner lookup, and `registerProjectRunLock` — registration + cached release that drains borrowers before lockfile retirement. No dependency on acquisition or mutation scheduling. |
| `mutation.ts` | Shared pending acquisitions, AsyncLocalStorage context, per-project mutation scheduling and closing/exclusive wait policy; compatibility re-export of `registerProjectRunLock`. |
| `release.ts` | `releaseLockFile` — ownership check, then shared retirement protocol. |
| `withLock.ts` | `withProjectRunLock` — acquire/run/release wrapper. |
| `inspect.ts` | `inspectProjectRunLock` — read `{holder, alive}`, no acquire. |
| `errors.ts` | `ProjectRunLockedError` (carries the contended `holder`). |
| `interruptedRun.ts` | `isResumableInterruptedRunLock` (which dead labels mean a Merge All / workflow Merge-Push step to resume) + the `interrupted-run.json` marker boot snapshot recovery writes before it steals such a lock, so `recovery/mergeRunResume.ts` still resumes the run and the owed post-merge hook still defers. Cleared by the resume once it has acted. |

## Invariants to preserve

- **Publish only a complete body** — exclusive `fs.link` is the lock; the
  publication's `wx` write targets the pending sibling. Never use read-then-write
  or an overwriting rename to publish `run.lock`.
- **Retirement requires the exclusive claim** — release keeps
  `sameLockBody`; release and stale recovery share `retireLockFile`. Keep the
  exact-raw-body recheck and tombstones, subject only to the bounded prune above.
- **Stealing requires proof of death** — only steal on unparseable, dead-PID,
  pre-our-process, or recycled-PID holders; uncertainty must fail safe
  (treat as alive / refuse).
- **Never auto-steal a remote-host or same-process lock.**

Behaviour is covered by `../__tests__/projectRunLock.test.ts`.
Command reference from `backend/`: `npm run build`, `npm test`,
`npx tsc --noEmit`. For a HOME-isolated single-file test invocation, see the
[test guide](../__tests__/CLAUDE.md).

## Resolver and snapshot mutations

`withProjectMutation(project, fn)` in `mutation.ts` explicitly borrows this
process's acquired ownership through a per-project queue, or acquires a short
owner if no run owns the project locally. An ownership record from another
backend is never borrowable. `ownership.ts` owns the single canonical-project
registry and registration/release wrapper, shared by `acquire.ts` and
`mutation.ts`. Its internal lookup returns the same live owner objects, including
their mutable queue tail and closing state; acquisition sharing, AsyncLocalStorage
context and scheduling/wait policy remain in `mutation.ts`. The existing
`mutation.ts` import path for `registerProjectRunLock` remains a re-export.
Resolver re-sync/finalization, snapshot capture,
and restoration all enter this queue; nested calls inherit the active slot via
AsyncLocalStorage. Only bounded repository operations belong in it, never a
wait for an agent callback. This lets a merge worker retain `run.lock` while its
callback safely finalizes. Release closes admissions, drains accepted mutations,
then retires the lock. A mutation that arrives while an owner is *closing* does
not fail immediately: it polls the local registry (25 ms steps, 2 s cap) until
the owner has drained and retired, then acquires afresh. No caller retries the
old "ownership is closing" throw, and for a resolver's one-shot Stop-hook
`/complete` it meant a 500 → the parked merge-run waiter was never signalled →
the run (and `run.lock`) sat idle for the waiter's 30-minute cap. The owner
stays registered until its lockfile is gone on purpose — an acquire attempted
earlier finds our own pid's lock on disk and is refused. Simultaneous standalone
callbacks share their acquisition.

The ownership tests are in `../__tests__/projectMutation.test.ts`.

## Exclusive (non-lendable) holds

`acquireProjectRunLock(project, label, { lendable: false })` registers an
owner that `withProjectMutation` will **not** borrow. Two users: the
post-merge-run housekeeping gc (`repo-maintenance`, `../worktree/repoMaintenance.ts`
— merging beside a repack leaves a full leftover pack copy on Windows; the
refusal message names it via `REPO_MAINTENANCE_BUSY_MESSAGE`; `startMergeRun` throws it as a typed `RepoMaintenanceBusyError`, also when it loses the lock race to this process's gc — `isLocalRepoMaintenanceHold`), and the
workflow Run tests step (`workflow-test:<runId>`, `../workflowRuns/testStep/`),
whose agent edits and commits on the main checkout for the whole hold — a
manual-merge resolver's finalize (`routes/tasks/finalizeResolved.ts` → snapshot
+ fast-forward) or a snapshot capture/restore must not run under it. Such a
mutation **defers**: `waitForExclusiveProjectHold` polls the local registry
(500 ms) until the holder leaves, then the mutation proceeds as if no owner had
been there (a leak backstop throws after `EXCLUSIVE_HOLD_WAIT_MAX_MS`, 13 h —
the step's own timeout caps it at 12 h). The post-merge hook fired outside a
merge run (`routes/tasks/hooks/postMergeHookHelper.ts`, reached from the
resolver `/complete`, `/merged` and `/stash-resolved`) waits the same way, so no
hook agent starts on the tree under the test agent. A **new** acquisition while
the hold is live (manual `/merge`, Merge All) is refused as usual —
`ProjectRunLockedError`'s message (`describeProjectRunLockHolder`) names the
Run tests step for a same-process `workflow-test:` holder instead of "another
process". `scripts/dev.mjs` treats every `workflow-*` label as exempt from its
15-minute forced restart, and `recovery/mergeRunResume.ts` never resumes a
merge run for a stale `workflow-test:` lock (the workflow resume re-takes it).
Covered by `../__tests__/workflowRunTestsStep.test.ts`.
