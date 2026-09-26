# backend/src/terminalRegistry

The durable terminal-tab registry: what lets the sidebar's tabs — and the
harness conversation inside each — come back after a backend restart, a closed
browser, a `Ctrl+C` of the dev server, or a reboot.

Before this, the tab list lived only in the browser's `sessionStorage`, the
backend never learned which harness conversation a pty was running, and a
normal `Ctrl+C` (`POST /shutdown`) killed every pty with nothing to relaunch
from.

## The model

- `types.ts` — `TerminalRecord`: one per tab the backend ever created a pty
  for. Carries the tab's decorations (`label`, `order`, `kind`, `taskId`,
  `startupId`), its `owner` (who decides when it disappears / whether restore
  may relaunch it), the ORIGINAL `launch` (command + harness + Pi model +
  `isQaRun` / `taskId` / `mcpScope`, before any Lattice injection), the pinned `agentSession`, the last pty
  (`serverId` + `serverInstanceId`), `lastBusy`, and `ended`.
- `store.ts` — `TerminalRegistryStore` (a `ProjectStateManager` subclass) over
  `~/.lattice/per-project/<hash>/terminals.json` (versioned envelope, atomic
  write, every field re-validated on read, long-ended records pruned). The
  BACKEND is the sole creator of records (`proxyCreateSession` →
  `recordSpawnedTerminal` in `terminalServerClient/createSession.ts`); the
  frontend only patches decorations. `end()` REMOVES a record for
  `exit` / `closed` / `killed` / `owner-finished` and KEEPS it (with the
  marker) for `cwd-missing` / `restore-failed` so the UI can show why.
  `endWhere()` is what the kill paths (`terminalProxy.ts` wrappers, the
  `/api/terminals/:id` DELETE) and the exit watcher use.
- `startupSupersede.ts` — `endSupersededStartupRecords`: when
  `recordSpawnedTerminal` creates a new `startup` record, every older record of
  the same `startupId` whose pty is definitely dead (no `serverId`, or a
  different executor instance) is ended `owner-finished`. Restore is otherwise
  the only thing that ends a dead startup record, and it doesn't run under
  `restoreTerminalsOnOpen: 'never'` / a declined `ask` — the exit watcher skips
  a replaced executor's records — so each restart used to leave another dead
  "session lost" startup tab. Same-instance records are left to the exit
  watcher (their pty may be alive).
- `labels.ts` — `shortLabel` (mirrors the frontend's `taskboard/lanes.ts`
  `shortLabel`: trim, cap at 18 chars with `…`), plus `taskTerminalLabel` /
  `mergeTerminalLabel`, so a backend-minted record carries the label the UI
  would have generated and a restored tab reads identically to the original.
  Keep it in lockstep with the frontend copy.
- `index.ts` — the barrel: re-exports the store, session identity,
  `buildRestoreCommand` / `RESTORE_NUDGE`, `restoreProjectTerminals`, the
  watch, Codex discovery, `detectInterruption` and the label helpers. Some
  callers (and the tests) import the individual modules directly; every
  currently exported name must keep working from both paths.

## Session identity

- `sessionIdentity.ts` — `assignHarnessSessionId`: pins the conversation id
  at launch. Claude `--session-id <uuid>`, Pi `--session-id lattice-<uuid>`
  (create-or-resume). Never stacks on a command that already names a session
  (`--resume`, `-c`, …). `agentSessionFromCommand` is the reverse: the id a
  live pty's spawned command carries (`--session-id` / `--resume` / Codex
  `resume <id>`), used when restore ADOPTS an orphan pty onto a record — the
  record's old id belonged to the dead pty, so it takes the adopted one's.
  Codex has no such flag (openai/codex#46672) —
- `codexDiscovery.ts` — learns a Codex thread id after the fact from
  `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl` line 1
  (`session_meta.payload.{id,cwd,timestamp}`): cwd match + started after our
  spawn + not claimed by another record, earliest first; `ambiguous` when two
  Codex tabs share a cwd in the window. Codex writes the rollout on the FIRST
  TURN, not at launch (measured 2m42s for a tab typed into late), so discovery
  polls until the id is known or the record ends — 2 s for 2 min, 15 s to
  30 min, then 1/min, 24 h backstop — and restore makes one last attempt right
  before relaunching an id-less Codex tab (else `resume --last`, the newest
  thread in the folder, maybe another tab's). A fresh pick must have STARTED
  within `CODEX_FRESH_START_WINDOW_MS` (2 min) of the tab's launch —
  `session_meta.timestamp` is the process start — so an idle tab can't claim
  the thread of a Codex tab opened later in the same folder.
  "Started after our spawn" is the record's `createdAt`, never the relaunch
  time: a `codex resume --last` relaunch reopens the ORIGINAL rollout, whose
  `session_meta` timestamp is the thread's creation. The cheap stat pre-filter
  keys on the file's mtime ≥ `restoredAt ?? createdAt` instead (the resumed
  file is being written now), and a relaunched record picks the NEWEST such
  file by mtime — `--last` reopened the most recently written thread, so the
  earliest-created candidate would be the wrong conversation. The day-directory
  window MUST still follow `createdAt` (a rollout lives in the day-dir of the
  day its thread started; resume appends to that old file). What keeps the
  polling cheap instead: the readdir + stat listing is taken once per
  `(root, days)` per 1.5 s and shared by every in-flight discovery
  (`listRolloutFilesShared`), and a parsed `session_meta` is cached for the
  process lifetime (line 1 never changes), so later ticks stat but never
  re-read. Ten restored Codex tabs used to cost ~600k stats over two minutes.
  Orphan adoption overrides these defaults with persisted `codexDiscovery`
  bounds from the adopted PTY's `createdAt`: a fresh command gets that process's
  start window; `resume --last` scans the bounded history by recent writes,
  since its thread may predate the tab. A later relaunch retains that creation
  floor and advances the write bound. An in-flight scan must discard evidence
  if the record changed PTYs / discovery provenance while it read the files.
- `harnessPaths.ts` — where each harness keeps transcripts (verified on
  Windows): Claude `~/.claude/projects/<cwd, non-alnum → '-'>/<id>.jsonl`, Pi
  `~/.pi/agent/sessions/--<cwd, [/\:] → '-'>--/<ts>_<id>.jsonl`, Codex rollouts.

## Relaunch

- `commandParse.ts` — a small shell-ish tokenizer / re-emitter for the launch
  commands Lattice builds, with a per-harness table of value-taking flags so
  the trailing prompt can be told from a flag value.
- `restoreCommand.ts` — `buildRestoreCommand`: original flags kept, session
  flags stripped, prompt dropped. Claude: transcript exists → `--resume <id>`,
  else (died before its first turn) `--session-id <id>` with the original
  prompt. Pi: `--session-id <id>`. Codex: `resume <id>` or `resume --last`.
  Plain shell → no command; a non-harness command reruns verbatim. The
  `RESTORE_NUDGE` prompt tells a relaunched agent to check git and continue.
  The Codex title config, harness system-prompt files and the task-worktree
  `--strict-mcp-config --mcp-config=…` flags are NOT here — the spawn
  chokepoint re-injects them like on any launch (the latter from the persisted
  `launch.mcpScope`). **A relaunch never
  overwrites the record's `launch`** (else the next restore would try to
  resume a resume).
- `interruption.ts` — also `findClaudeConversationId`: the pinned Claude id
  names the PROCESS, not necessarily the conversation. Interactive transcripts
  stamp each line with `sessionId` (conversation = file name) and `session_id`
  (the process); after an in-tab `/resume` the process appends to the OTHER
  conversation's file and its own may never exist, so a relaunch from the
  pinned id alone opened a blank Claude (tab "claude! 2", 2026-09-24). The
  detector scans the cwd's transcripts modified since the tab's CREATION
  (not its last relaunch — the switch may be several fresh relaunches old),
  newest first, for the last line whose `session_id` is the pinned id, and
  returns that conversation as the verdict's `agentSession`
  (`source: 'transcript-scan'`); the relaunch resumes it and records it (a
  `--resume Y` process runs as Y, so it keeps working next time).
  "Was the agent mid-turn when it died?" Two evidence
  sources: the transcript tail (claude dangling `tool_use` / trailing user
  prompt → open, the `[Request interrupted by user…]` marker → idle; pi
  `stopReason`; codex `task_started` without `task_complete`) and a
  busy-at-death record (Claude's own `~/.claude/sessions/<pid>.json`
  `status`, else Lattice's persisted `lastBusy`). `decideInterruption`:
  nudge only on open + non-idle; any idle evidence vetoes; unknown never
  nudges. Gates the user-tab nudge (`restoreNudgeUserTabs`).
- `restore.ts` — `restoreProjectTerminals(project, deps?, {retryFailed?})`,
  single-flighted per project **including while its relaunch thunks are still
  running** (a second pass answers `already-running`; the lock release is
  identity-checked so an old pass's guard timer can't drop a newer pass's
  lock; the thunk also skips a record that regained a pty meanwhile), safe to
  re-run. Candidates are the non-ended records — plus, ONLY when
  `retryFailed` is set (the sidebar's explicit "Restore tabs" click sends
  `?retry=1`), the ended-but-retryable ones (`cwd-missing` / `restore-failed`).
  The on-open pass never retries those: it used to re-report the same drop on
  every reload and reset the retention clock. Per candidate: pty live →
  adopt; unclaimed live AGENT pty in the same cwd + harness → adopt (plain
  shells and startup commands never adopt — with no harness to match on they
  would claim any pty in the folder; a retried record adopts too, so a relaunch
  whose pty landed but whose bookkeeping failed is never spawned beside).
  Adoption clears `ended` / `relaunching` before emitting `restored`, including
  when the record already names its live PTY. An orphan replaces the dead
  PTY's identity even when unknown, clears its busy evidence, and restarts
  discovery using the adopted process's provenance; pty
  gone while the executor INSTANCE is unchanged → it exited → end; otherwise
  relaunch if the owner allows (`user` — cwd must exist; `task` — still
  `in_progress` with its worktree; `merge` — NEVER relaunched: a dead resolver
  is ended silently because the merge-run recovery / a re-clicked merge spawn
  their own, and a relaunch racing them puts two Claudes on one conflict —
  a live resolver is adopted like anything else; `startup` — never: the dead
  record is ended silently and `useStartupTerminals` re-seeds a fresh one;
  one-shot runs — never, ended as `owner-finished`). Relaunches clear the dead
  `serverId` (and any `ended` marker) first — every client renders the tab as
  "restoring", no pane attaches to a dead id — go through the spawn queue at
  `batch` priority, and land as `restored` / `restore-failed` events. An
  unreachable executor changes nothing. Re-ending a record for the same reason
  keeps its original `ended.at`. The single-flight is held until the pass's
  relaunches settle, but never longer than `RELAUNCH_LOCK_MAX_HOLD_MS`
  (10 min). Step 2's orphan adoption is `tryAdoptOrphan`.
- `restoreRelaunch.ts` — the relaunch half, split out of `restore.ts` (which
  still owns the per-record decision and the exports `restoreProjectTerminals`,
  `RestoreDeps`, `RestoreOptions`, `isRetryableEnd`; this module imports only
  the `RestoreDeps` TYPE back, so there is no runtime cycle).
  `enqueueRelaunch` queues the `terminal-restore` thunk (re-checks the record
  — closed / re-backed meanwhile ⇒ nothing to spawn; one last Codex discovery;
  `planRelaunch` → `buildRestoreCommand` → `createSession` with
  `existingId`; kills a pty whose tab closed mid-spawn; a CAP error throws
  `SpawnCapacityError` so the queue retries). `planRelaunch` = the nudge
  decision + Claude transcript-exists + a re-learned conversation, from one
  `detectInterruption` read. Both failure paths (a spawn error, a rejected
  thunk) go through `markRelaunchFailed`: clear `relaunching` → end
  `restore-failed` at the FIRST failure's `at` → `emitRestoreFailed`; the
  rejected-thunk path is best-effort (each registry write's error swallowed).
  `scheduleDiscoveryIfUnknown` keeps an id-less adopted Codex tab polling.
- `watch.ts` — `startTerminalRegistryWatch` (boot): every 3 s diff loaded
  records against `/sessions` + `/health.instanceId` (pty missing, same
  instance ⇒ `exit`) and stamp `lastBusy` transitions from the
  terminal-activity signal (kept always-on for this). The session list is read
  LIVE (`proxyListSessionsOrNull`), deliberately NOT the activity poller's
  shared ≤750 ms snapshot (`proxyListSessionsShared`): a snapshot taken before
  a pty was spawned reports it missing, and this read's verdict is "ended —
  exit", which deletes the record. A tab created inside that window lost its
  record within a tick when the watch briefly used the snapshot. Even a live
  read has that window (the GET is in flight, or the caller awaits other work
  before judging), so the view carries `listedAt` and `isNewerThanLiveView`
  exempts any record written at/after it (`updatedAt`) from the verdict for
  that pass: the watch defers its "exit" to the next tick (re-reading the
  record first, since `loadedRecords()` is a pre-await snapshot), and restore
  treats such a record as live — adopt, never relaunch beside it. `noteBusy`
  likewise only stamps `lastBusy` onto a record still on the pty its snapshot
  named.

## Surfaces

`routes/terminalTabs.ts` (`GET`/`PATCH`/`DELETE /api/terminal-tabs[/:id]`,
`POST /api/terminal-tabs/restore`) and `ws/endpoints/terminalTabs.ts`
(`/ws/terminal-tabs`: `hello`, `upsert`, `ended`, `removed`, `restored`,
`restore-failed`, `restore-summary`). Settings (`userSettings/types.ts`):
`restoreTerminalsOnOpen` (`always` | `ask` | `never`), `restoreNudgeAgents`
(default on), `restoreNudgeUserTabs` (default off). `Task.agentSession` is
copied from the spawn so `routes/tasks/resumeTask.ts` can do a TRUE resume of
the worktree conversation when the harness matches.

## Invariants

- The registry must never touch a pty of another executor instance, and
  "can't list sessions" is never "no sessions".
- Records are keyed by a backend-minted id that the frontend adopts as the
  tab id; every spawn site returns it (`terminalId`) alongside `serverId`.
- The startup-terminal stale-drop (`frontend/.../useStartupTerminals.ts`) must
  skip registered tabs — closing a dead-pty tab there DELETEs the record and
  leaves nothing to restore (the bug the first e2e run found).
- Tests: `__tests__/terminalRestoreCommand.test.ts`,
  `terminalInterruption.test.ts`, `terminalRegistryStore.test.ts`,
  `terminalRestore.test.ts` (the decision matrix with injected deps),
  `terminalRestoreTranscripts.test.ts` (the same flow over real on-disk
  Claude / Pi / Codex files: re-learning, adopt, Codex discovery),
  `terminalRegistryWatchRace.test.ts` (live-view vs concurrent-spawn races),
  `terminalStartupSupersede.test.ts` (a re-seeded startup ends its dead predecessor).
