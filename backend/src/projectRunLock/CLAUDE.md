# backend/src/projectRunLock

Cross-process exclusion for repo-mutating runs — **defence layer #8** in the
root `CLAUDE.md`'s `.git`-deletion defences. The in-process guards (the
`mergeRuns.ts` singleton, `mergeLocks.ts`) only stop races *within one*
Lattice process; this stops two Lattice processes (the classic case: Lattice
opened on its own repo while another instance has the same repo as a project)
from entering the merge pipeline at once and racing on `git status` /
snapshot / fast-forward. `../projectRunLock.ts` is the public facade.

## What it guards

One lockfile per project: `~/.lattice/per-project/<sha1(canonicalPath)[:12]>/run.lock`
(confirm via `paths.ts` → `homeProjectDir`). Body is `{pid, hostname,
startedAt, label}`. Held for the duration of a merge run (`label:
merge-run`) and a manual `/merge` (`label: manual-merge`); `label` exists
only so a human inspecting the file knows what's holding it. Created with the
`wx` flag (atomic fail-if-exists) — that's the actual mutual-exclusion
primitive; everything else is staleness handling.

**2026-09 stability correction:** publication now writes a unique sibling with
`wx`, then uses `fs.link(pending, run.lock)` to atomically publish the complete
body without overwriting an existing lock. A direct asynchronous `wx` write to
`run.lock` exposes an empty file before its body is written; a competing acquire
could classify that as corrupt and steal it, admitting both callers. Keep the
exclusive publication step. Unsupported hard-link filesystems fail acquisition
rather than falling back to the unsafe partial-body publication.

## Lifecycle

**2026-09 ownership correction:** every newly issued body includes a UUID
`ownerId`. Release and stale recovery share `retireLockFile`, which must win an
exclusive permanent tombstone at `run.lock.retired/<sha256(exact raw body)>`
before unlinking. Only one observer can ever remove that generation, so a
suspended stale observer cannot remove its successor. A body comparison alone
does not provide this guarantee. Read errors other than ENOENT refuse recovery.
Tombstones also distinguish legacy generations by their entire original bytes.

Keep the tombstones: deleting them while any process can retain an observation
reintroduces the race. They contain tiny retirement audit records. A crash after
claiming retirement but before unlink leaves the old lock blocked deliberately;
the diagnostic requires stopping all backends before inspecting/removing only
`run.lock`, preserving the tombstones. This is a fail-closed availability limit,
not automatic crash recovery. Running an older backend that ignores tombstones
concurrently with this protocol is unsupported; upgrade all backends together.

`acquire → (steal if stale) → release`, almost always via the
`withProjectRunLock(projectPath, label, fn)` wrapper (acquire, run `fn`,
release in `finally`). `acquireProjectRunLock` tries the atomic `wx` write;
on `EEXIST` it calls `clearStaleLockOrThrow` once and retries — exactly two
attempts, then it surfaces the error rather than spinning. `release` deletes
the file **only if it still holds our exact body** (`sameLockBody`), so a
late release can't remove a lock that was stolen and recreated by someone
else. `inspectProjectRunLock` reads `{holder, alive}` *without* acquiring or
stealing — used by recovery's merge-run resume to spot an interrupted run
and by `scripts/dev.mjs` to decide whether to defer a restart.

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
| `lockfile.ts` | Read/parse/`wx`-write/delete + `sameLockBody` — all raw fs. |
| `liveness.ts` | `currentLockBody`, PID-alive probe, PID-reuse disambiguation. |
| `steal.ts` | `clearStaleLockOrThrow` — decide steal vs. throw. |
| `acquire.ts` | `acquireProjectRunLock` — `wx` write + one steal-retry. |
| `release.ts` | `releaseLockFile` — delete only if still ours. |
| `withLock.ts` | `withProjectRunLock` — acquire/run/release wrapper. |
| `inspect.ts` | `inspectProjectRunLock` — read `{holder, alive}`, no acquire. |
| `errors.ts` | `ProjectRunLockedError` (carries the contended `holder`). |

## Invariants to preserve

- **Acquire stays atomic** — the `wx` write is the lock; never replace it
  with read-then-write.
- **Release is ownership-gated** — keep the `sameLockBody` check so a stolen
  lock survives the original holder's late release.
- **Stealing requires proof of death** — only steal on unparseable, dead-PID,
  pre-our-process, or recycled-PID holders; uncertainty must fail safe
  (treat as alive / refuse).
- **Never auto-steal a remote-host or same-process lock.**

Behaviour is covered by `../__tests__/projectRunLock.test.ts`.
