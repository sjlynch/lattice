# backend/src/__tests__

Backend tests use Node's built-in `node:test` runner with `tsx` for TypeScript
execution (`npm test` from `backend/`). The `test` script `--import`s
`helpers/isolateHome.mjs` first, redirecting `HOME`/`USERPROFILE` to a throwaway
temp dir so the suite never writes into the real `~/.lattice` (task DBs,
`projects.json`, snapshots) — it must load before any test imports the task
cache, whose home path binds once at module load. Keep tests as plain
`.test.ts` files in this directory unless a helper belongs under `helpers/`.

## Conventions

- Import assertions from `node:assert/strict` and test APIs from `node:test`.
- Prefer focused pure-unit coverage; use temp dirs from `helpers/tempDir.ts` for
  filesystem tests and clean them in `t.after`/`finally`.
- Tests run in one Node process against source files; avoid global mutable state
  leaks, real dev-server dependencies, or long-lived timers.
- When testing route handlers, build the router/app in-process rather than
  starting the backend server.

## Suite index

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
- `latticeApiDocsDrift.test.ts` — pins the two hand-maintained API docs against
  the real router. `latticeApiDocs.ts` only guarantees a project's
  `.lattice/LATTICE_API.md` matches the *template* that shipped with the build
  (content-hash in line 1), so a renamed endpoint left the template — and every
  regenerated copy on every machine — confidently documenting a dead path.
  Builds the Express app in-process via `mountRouteFactories` and walks the
  router stack (asserting the prefix-less-mount assumption the collector rests
  on), then checks both directions: every endpoint-table row and every
  copy-pasteable `$LATTICE_API_URL/...` recipe must resolve to a live route, and
  every live route must either be documented or carry an entry in the test's
  `UNDOCUMENTED_ROUTES` map explaining why agents shouldn't see it (hook
  callbacks, Settings-UI surfaces, MCP secrets, graph reads). **That opt-out map
  is the drift guard** — a new route fails the suite until someone decides which
  side it belongs on. A final case holds the root `CLAUDE.md` HTTP table to
  total coverage in both directions (it caught `POST /api/terminals` missing).
- `cleanupSafety.test.ts` — the two `.git`-deletion throw-guards in
  `worktree/cleanupSafety.ts`: `assertSafeWorktreePath` (empty/whitespace path,
  the repo root, out-of-bounds and wrong-project paths, the managed base dir
  itself; accepts home + legacy worktree paths) and `assertNotReparsePoint`
  (no-op on real files/dirs, silent on ENOENT, throws on a junction and on a
  path reached *through* one — the branch lstat alone can't catch). Temp-dir
  fixtures use `fs.symlink(…, 'junction')` like `pruneReparsePoints.test.ts`.
