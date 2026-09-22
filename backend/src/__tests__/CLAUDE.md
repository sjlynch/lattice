# backend/src/__tests__

Backend tests use Node's built-in `node:test` runner with `tsx` for TypeScript
execution (`npm test` from `backend/`). The `test` script `--import`s
`helpers/isolateHome.mjs` first, redirecting `HOME`/`USERPROFILE` to a throwaway
temp dir so the suite never writes into the real `~/.lattice` (task DBs,
`projects.json`, snapshots) — it must load before any test imports the task
cache, whose home path binds once at module load. It also sets
`LATTICE_TEST_HOME_ISOLATED`; a test that writes under `~/.lattice`
(`opengrepScan`, `opengrepInstall`) throws at import when the marker is absent,
so a bare `node --test src/__tests__/x.test.ts` (no `--import`) cannot land
fixtures in the developer's real home — run one file with
`node --import tsx --import ./src/__tests__/helpers/isolateHome.mjs --test <file>`.
Keep tests as plain `.test.ts` files in this directory unless a helper belongs
under `helpers/`.

## Conventions

- Import assertions from `node:assert/strict` and test APIs from `node:test`.
- Prefer focused pure-unit coverage; use temp dirs from `helpers/tempDir.ts` for
  filesystem tests and clean them in `t.after`/`finally`.
- Tests run in one Node process against source files; avoid global mutable state
  leaks, real dev-server dependencies, or long-lived timers.
- When testing route handlers, build the router/app in-process rather than
  starting the backend server.

## Suite index

- `terminalRestoreCommand.test.ts`, `terminalInterruption.test.ts`,
  `terminalRegistryStore.test.ts`, `terminalRestore.test.ts` — the durable
  terminal-tab registry (`terminalRegistry/`). Command parsing round-trips the
  quoted prompts `agentCommandBuilder` emits; `assignHarnessSessionId` pins a
  UUID on Claude / a `lattice-` id on Pi and never stacks on a user's own
  `--resume`; `buildRestoreCommand` per harness (Claude `--resume` vs the
  transcript-missing `--session-id` fallback, Pi `--session-id`, Codex
  `resume <id>` / `--last`, shell, verbatim). The interruption classifiers on
  transcript fixtures (dangling tool_use, Esc marker, Pi `stopReason`, Codex
  `task_started`) plus the veto matrix. The store's versioned file, ended
  semantics (remove vs keep) and busy stamping. And the restore decision matrix
  driven through the real store with injected live-session / spawn / task /
  settings deps: adopt, adopt-orphan-by-cwd, exited-not-relaunched, relaunch
  with `--resume` under the same tab id, nudge gating, owner rules, cwd
  missing, fresh Claude fallback, spawn failure, unreachable executor.
- `ignoredPathNamespace.test.ts` — `matchIgnoredSourcePath` against the
  `\\?\C:\…` extended-length paths the Windows recursive watcher reports when
  a watched ROOT is deleted or renamed. `path.relative` returned them
  unchanged and the `ignore` package threw from inside an `fs.watch`
  callback — an uncaughtException that killed the backend the moment a user
  deleted a project folder Lattice had open (2026-09-20, three crash files in
  one second). Pins the prefix strip, the other-root / out-of-project cases,
  and that a throwing matcher reads as "not ignored" rather than fatal.
- `codexTerminalActivity.test.ts`, `codexActivityReplay.test.ts` — per-launch
  status-title defaults, actual Codex Ready/Working lifecycle traces, animated
  idle output, and a real animations-disabled turn silent for over 20 seconds.
  Codex activity must never fall back to output recency.
- `terminalActivityRelay.test.ts`, `terminalWsRelayActivity.test.ts` — existing
  stream compatibility for old executors: split titles, complete replay,
  independent viewer ownership, byte/binary forwarding, disconnect cleanup,
  serverless command defaults, and no extra connections/input/resizes.

- `watchTree.test.ts` — the recursive tree watcher behind the health and
  git-status watchers. The headline case is the Windows directory lock it exists
  to fix: chokidar's per-directory/per-file `fs.watch` handles made any project
  directory containing a subdirectory impossible to rename or delete while
  Lattice had the project open, which broke the `mv` / `rm -rf` an agent does
  when scaffolding — so a win32-gated case renames and deletes a watched
  `parent/child/` tree and asserts it succeeds. The rest pins the event
  derivation, which the recursive backend has to synthesize by diffing a
  snapshot rather than getting natively: add/change/unlink for files, addDir +
  nested add, a recursive delete reported only at the top still emitting each
  child's `unlink` (else the graph keeps stale nodes forever), and the ignore
  predicate never leaking `node_modules`.
- `crashLog.test.ts` — the crash file is the only record a backend or
  terminal-server death leaves, so this pins the properties that make it worth
  having: the error *and* the preceding log context land on disk, a non-Error
  rejection reason is still captured, retention caps a crash loop at 20 files,
  same-millisecond crashes get distinct filenames (they used to overwrite each
  other), and the logs live home-scoped under `~/.lattice/logs/` rather than in
  a project. `installCrashLogging()` itself is not exercised — it patches the
  global console and registers process handlers, which would leak into every
  other test in the runner.
- `consoleSink.test.ts` — the freeze that took every project to a permanent
  "Scanning…" on 2026-08-20: a text selection in the `npm run dev` console
  window pauses console output, blocking TTY writes park the orchestrator's
  event loop, and once the `[backend]` pipe filled the backend's next
  `console.log` parked *its* loop — no HTTP, no WS, no Stop-hook callbacks, a
  merge run's `run.lock` held indefinitely, all at 0% CPU. The headline case
  spawns a child whose stdout nobody reads and asserts its timers keep firing
  through the stall and that it recovers when the reader resumes (the parent's
  `resume()` is the user pressing Esc). Around it: the queue stays bounded and
  drops oldest-first while reporting the loss, paced output is never dropped and
  keeps its order, a fatal error while stalled still exits non-zero (plain
  `process.exit` can't — libuv joins its thread pool at exit, so the process
  would hold port 5184 forever), the last line before a deliberate exit still
  reaches the console, and the dev orchestrator's parallel `.mjs` sink honours
  the same contract.
- `agentCommandBuilder.test.ts` — `buildAgentCommand()` harness framing
  (claude/pi/codex) + its private `shellDoubleQuoted()` prompt-quoting guard
  (double-quote/backslash/dollar/backtick each escaped once; injection prompts
  neutralised). Pure unit test, no spawning.
- `terminalActivity.test.ts` — the two pure halves of the sidebar tab spinner's
  signal: `agentHarnessForCommand()` (every Lattice-built agent command incl.
  rewriter-mangled ones; quoted/absolute paths and `.cmd` shims; and the
  rejections that matter — a plain shell, `npm run dev`, and substring
  near-misses like `claudette`, any of which would pin a spinner on forever) and
  `stepTerminalActivity()`, driven as a sequence of polls over a virtual clock.
  The headline case is the **self-inflicted-redraw** regression: opening a
  sidebar tab blurs the pane you were on, xterm reports it to the pty as a focus
  escape, and the idle harness redraws — which recency alone read as "working",
  spinning the tab you just left for the whole idle window. Pinned from both
  sides: the redraw stays out of the busy set at every tick (and when its burst
  straddles two polls), *and* the same sequence with the run floor removed
  (`minRunMs: 0`) still lights it, so the assertion can't pass for the wrong
  reason. Its sibling is the **user-driven** redraw the floor can't catch:
  scrolling repaints for as long as the gesture lasts, so the `inputAt` stamps
  the relay records are what disqualify it — pinned as a five-second scroll that
  never spins (during OR after), against the case that must not regress (input
  stops at the Enter key, the agent's output runs away from it, spinner on), and
  against a redraw landing inside a just-finished turn's still-open run, which
  the floor alone lets through and the paired no-stamp assertion shows it does.
  Around that: a genuinely streaming harness turns the spinner on and off, a run
  doesn't survive a gap wider than the idle window, a shorter pause doesn't
  break it, both thresholds' boundaries, a spawn-seeded `lastOutputAt` is not
  work, agent-only filtering (a chatty plain shell satisfies the run floor and
  must still be excluded), sorted output the poll loop diffs as a string,
  malformed entries from the cross-process JSON, and the carried state dropping
  closed ptys. No timers or terminal-server.
- `terminalOutputFacts.test.ts` — the Codex control-only idle regression,
  working-to-idle transition, escape sequences at every chunk split, Unicode
  and hyperlink text, large control payloads, and actual session-event/list
  wiring preserving raw bytes while reporting printable-output timestamps.
- `terminalActivityPoller.test.ts` — subscription generations, late responses,
  unknown/hung probes, bounded stale display state, change-only fanout and
  subscriber failures with a deterministic clock and no real terminal server.
- `worktree.merge.branchState.test.ts` — `checkBranchState()` merge state
  machine across all four outcomes (error/already-merged/empty/ahead); pins the
  safety invariant that a THROWN commit-count surfaces as `error` (never a
  silent empty/already-merged), stubbing the `../state.js` git reads via the
  module's injectable deps seam.
- `waiterLiveness.test.ts` — `awaitResolverWaiter` bounded-lifetime backstop for
  a parked merge-run conflict waiter: signal wins, a vanished resolver pty
  releases as `resolver-dead` after consecutive strikes, an interleaved "can't
  tell" resets the strike count, the wall-clock cap yields `timeout`, and the
  synchronous-registration ordering the park sites depend on holds. Uses a
  virtual-clock + fake `listSessions` deps seam (no real timers/terminal-server).
- `mergeRunConflictPark.test.ts` — `parkOnConflictResolver` drops the per-task
  merge lock before waiting and still resumes on a signal that races the await
  (guards the resolver-finalize deadlock).
- `mergeAbortedAuthoritative.test.ts` — `/merge-aborted` is authoritative: a late
  `/merged` from an abandoned resolver no-ops (conflict-flag gate), AND a
  merge-run worker parked on the conflict waiter is released so the project
  run-lock is freed (Part A of the parked-waiter wedge fix).
- `repoIntegrity.test.ts` — `checkRepoIntegrity`, the merge-run circuit breaker
  (`.git`-deletion defence #6). Both failure directions: it must fire on a
  vanished `.git`, an unreadable HEAD, and a HEAD moved *sideways* to a
  non-descendant; it must NOT fire on a null baseline (HEAD was already
  unreadable at run start), an unchanged HEAD, or a fast-forward. The first two
  cases are pure fs (a bogus empty `.git` dir proves no git spawns); the
  HEAD-movement cases drive a real temp repo via `execFile` git.
- `distRestartVerify.test.ts` — the dev runner's verify-before-restart guard
  (`scripts/dev/distSignature.mjs`). On Windows `fs.watch('dist')` also fires
  for metadata-only touches (NTFS last-access flush, AV scan, ACL refresh), and
  the runner used to restart the backend for each one — killing in-flight runs
  on days when nothing was compiled. Covers `shouldRestartForDist` (newer →
  restart, same/older → ignore, unknown → fail OPEN), `newestDistMtimeMs`
  (nested write / create / **delete**, the last only detected because directory
  mtimes are folded in; `null` rather than `0` when unreadable, since `0` would
  suppress every restart), `describeDistEvent`, and the policy wiring: a
  metadata-only event neither restarts nor arms a deferral the poll could later
  apply, while a real write restarts once and names the event that fired.
- `workflowRunResume.test.ts` — workflow-run durability across a backend
  restart (the "run vanished from the navbar mid-step" incident). Covers
  `classifyWorkflowRunResume`'s full decision table (live agent pty → readopt;
  an unprobeable terminal-server → readopt, never error; a dead agent pty →
  error; control steps → redispatch; finished/deleted-definition/out-of-range
  edges), `findStepSessionId` cwd matching, the on-disk mirror (round-trip,
  non-`running` records dropped, corrupt file degrades to `[]`, empty state
  deletes the file, `notify` keeps it current), and the headline pair: a
  `/complete` callback for an unknown run is a silent no-op, but after
  `restoreWorkflowRun` the very same callback advances the workflow.
- `workflowFrozenSteps.test.ts` — the editor's freeze toggle end to end: the
  pure `nextRunnableStepIndex`/`isStepFrozen` policy (leading/middle/trailing
  frozen, all-frozen and empty → `null`, clamped negative `from`), the
  `normalizeSteps` coercion (only a literal `true` freezes; not-frozen stays
  *absent* from the JSON, never `false`), and the two run-engine consumers — an
  all-frozen workflow is refused by `startWorkflowRun` with no run record left
  behind, and advancing onto trailing frozen steps completes the run (index
  parked past the last step) instead of spawning them or hanging.
- `defaultPromptMigrations.test.ts` — the planner-only contract for workflow
  steps, both halves. (1) `workflows/defaultPromptMigrations.ts`: prefix matching
  keeps the editor's appended `{{user_instructions}}` / project-tailoring suffix,
  migration is idempotent + CRLF-tolerant, a hand-edited prompt is never touched,
  every legacy generation lands on the newest wording, and no shipped `current`
  body still tells the agent to commit. (2) the rendered `WORKFLOW_STEP.md`: the
  "you are planning, not implementing" rule appears **above** the step prompt and
  claims precedence over it, Claude's completion line no longer reads as
  boilerplate that a task-less step prompt can dismiss, and the brief points at
  `LATTICE_API.md` + the PATCH/DELETE calls the helper script lacks. Also pins
  `current` against the frontend `prompts/*.md` bytes so the backend and frontend
  copies of each built-in prompt cannot drift.
- `latticePreamble.test.ts` — the always-on Lattice discovery preamble folded
  into every harness system prompt. Pins the properties that make it safe to
  ship on EVERY spawn: it names Lattice + its trigger words + the literal doc
  path; it is one line with no double quote and no `'''` (both would break the
  Codex `-c developer_instructions` value transiting cmd.exe as `"%VAR%"`); it
  stays under 600 chars; it resolves to `null` for a project with no
  `.lattice/` dir (so an unmanaged cwd spawns stock) and generates the
  reference for one that has it; and `composeSystemPromptAppend` orders the
  preamble before the project's own Append while tolerating a blank/absent
  side. Its integration half lives in `harnessSystemPrompts.test.ts` ("a
  project with no override still gets the Lattice preamble").
- `latticeApiDocs.test.ts` — the generated agent docs. `ensureLatticeApiDoc`
  writes TWO files into `<project>/.lattice/`: the SHORT index the system-prompt
  preamble names (`LATTICE_API.md`) and the recipes file it points at
  (`LATTICE_API_RECIPES.md`). Pins what makes that split work — every literal is
  interpolated in both (no `{{…}}` remnant, no `_FWD}}` clipped by the shorter
  `{{PROJECT}}`), the index names the recipes file by ABSOLUTE path, neither
  references a shell variable (cmd.exe can't expand one), each file carries its
  own content-hash stamp so regeneration is byte-stable and editing one template
  rewrites only that file, and nothing is written when `.lattice/` is absent.
  The load-bearing one is the **size budget**: the index is read WHOLE on every
  Lattice question, so it must stay under 4096 bytes rendered — it was 19 KB
  (~5k tokens) before the split, and without the budget it silently regrows.
- `latticeApiDocsDrift.test.ts` — pins the hand-maintained API docs against
  the real router. `latticeApiDocs.ts` only guarantees a project's
  `.lattice/LATTICE_API*.md` match the *templates* that shipped with the build
  (content-hash in line 1), so a renamed endpoint left them — and every
  regenerated copy on every machine — confidently documenting a dead path.
  Builds the Express app in-process via `mountRouteFactories` and walks the
  router stack (asserting the prefix-less-mount assumption the collector rests
  on), then checks both directions over the UNION of both templates (the
  endpoint table lives in the recipes file since the progressive-disclosure
  split, so reading only one would drop half the cover): every endpoint-table
  row and every copy-pasteable `{{API_URL}}/...` recipe must resolve to a live
  route, and every live route must either be documented or carry an entry in the test's
  `UNDOCUMENTED_ROUTES` map explaining why agents shouldn't see it (hook
  callbacks, Settings-UI surfaces, MCP secrets, graph reads). **That opt-out map
  is the drift guard** — a new route fails the suite until someone decides which
  side it belongs on. A final case holds the root `CLAUDE.md` HTTP table to
  total coverage in both directions (it caught `POST /api/terminals` missing).
- `taskCacheDurability.test.ts` — task-DB durability holes around load,
  boot restore and migration: a `tasks.json` that parses but isn't an array is
  preserved aside rather than overwritten; boot restore skips on a non-ENOENT
  read error (a lock must not roll the DB back to the backup) and preserves a
  corrupt main file before restoring; first-touch migration leaves a
  backup-only home dir for recovery instead of copying the stale in-project
  legacy file over the newer backup; the global legacy migration survives a
  path-less row and sets its file aside when a project fails; and (in a child
  process) a task created just before `process.exit()` reaches disk via the
  `flushOnExit` sync flush.
- `cleanupSafety.test.ts` — the two `.git`-deletion throw-guards in
  `worktree/cleanupSafety.ts`: `assertSafeWorktreePath` (empty/whitespace path,
  the repo root, out-of-bounds and wrong-project paths, the managed base dir
  itself; accepts home + legacy worktree paths) and `assertNotReparsePoint`
  (no-op on real files/dirs, silent on ENOENT, throws on a junction and on a
  path reached *through* one — the branch lstat alone can't catch). Temp-dir
  fixtures use `fs.symlink(…, 'junction')` like `pruneReparsePoints.test.ts`.
- `gitIdentityUntouched.test.ts` — Lattice must never write the HOST's git
  identity/config. Every spawned agent runs permission-bypassed (`--yolo` /
  `--dangerously-skip-permissions` / `--approve`) and several briefs tell it to
  `git commit`; when git can't resolve an identity its own error text instructs
  the reader to run `git config --global user.name "Your Name"`, and a full-auto
  agent complies — stamping a placeholder onto `~/.gitconfig` that the user's
  own later commits then carry. Pins all three layers: `projectGit` denies
  `config` in every form (incl. the `-c user.name=…` override), no shipped
  source outside `__tests__/` names a git-identity write marker
  (`--global`/`--system`/`GIT_{AUTHOR,COMMITTER}_*`/`user.name`/`user.email` —
  the scope flags matched with a trailing boundary so Claude's
  `--system-prompt-file` isn't a false positive), and each commit-instructing
  brief (task / merge / push / post-merge-hook) still routes the identity error
  to the **per-commit recovery** rather than a dead end. That last case is the
  load-bearing one: a prohibition that leaves the agent stuck just trades a
  polluted `~/.gitconfig` for an abandoned task, so it asserts all four of the
  parts that make the recovery work — the verbatim `Author identity unknown`
  git prints, the `never fix it with git config` rule, the `--local` clause
  (the trap an agent falls into the moment it's told not to use `--global`,
  since a worktree shares the project repo's config file), the
  `git log -1 --format="%an <%ae>"` that tells it where to FIND an identity,
  and the `git -c user.name=…` form that persists nothing.
- `startupTerminalsShape.test.ts` — the shape boundary in
  `userSettings/storage.ts`. `PATCH /api/settings` types its body as
  `Partial<UserSettings>` and agents write it directly, so the type guarantees
  nothing at runtime: an agent-guessed `{name, command}` row (no `id`, no
  `label`) was stored verbatim and the Settings dialog then threw on
  `label.trim()`, taking that project's settings permanently out of reach of the
  only UI that could repair the row. Covers healing on read (the interview_eci
  row verbatim, with `name` honoured as a label alias rather than the row being
  discarded), coercion on write, junk/commandless/non-array inputs, an explicit
  `id` surviving untouched, and a patch that omits the field leaving the saved
  list alone. The load-bearing case is **id stability across reads** — the
  frontend matches a live startup pty to its config by `id`, so a minted id that
  changed per read would spawn a duplicate terminal on every reload; its sibling
  pins that two identical id-less rows still get distinct ids.
- `projectStateNotifyCoalesce.test.ts`, `concurrencyLimit.test.ts`,
  `healthWatcherCoalescing.test.ts`, `sharedSessionSnapshots.test.ts`,
  `terminalRelayFramePretest.test.ts`, `projectIdentityMissingMemo.test.ts` —
  the hot-path guards from the 2026-09 performance audit, each pinned at its
  injectable seam: `ProjectStateManager.notifyProject` delivers ONE snapshot
  per project per turn (a 200-task bulk transition used to push 200 whole-board
  WS frames per client) and a throwing subscriber is isolated; the bounded
  limiter behind the watcher's file reads caps in-flight bodies, drains FIFO
  and releases on throw; directory `rescan` bursts coalesce and the cross-file
  present-file `Set` keeps its identity across content-only passes (the
  case-fold memo's key); the `/sessions` and Codex-rollout listings are
  single-flighted and TTL-shared, with "can't tell" (`null`) passed through
  rather than coerced to `[]`; the relay's raw-frame title pretest skips plain
  output yet still feeds a mid-escape parser and always parses non-data
  frames; and a failed project realpath is probed once per event-loop turn
  (500 tasks of a deleted project → one syscall) but again on the next turn
  (the "not negatively cached before directory creation" contract). Related
  in-suite additions: `taskListQuery` pins that the list envelope's wire form
  equals `JSON.stringify(envelope)` while being serialized once, and
  `worktreeModified` that concurrent loads of one project single-flight.
