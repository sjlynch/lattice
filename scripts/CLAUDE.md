# Root scripts

- `preflight.mjs` runs before the orchestrator and self-heals `node_modules`
  across root / backend / frontend. It compares what each workspace's
  `package.json` **declares** (`dependencies` + `devDependencies`) and the
  version its `package-lock.json` pins against what is installed, via the
  shared `depsCheck.mjs` (`backend/scripts/dev/deps.mjs` uses the same module
  for its own second-layer check; typed in `depsCheck.d.mts`, unit-tested in
  `backend/src/__tests__/depsCheck.test.ts`). **Do not reintroduce a
  hand-picked package sample** — the old "is express there? is vite there?"
  probe let a pulled `@modelcontextprotocol/sdk` + `zod` addition pass
  preflight and die in the backend's initial `tsc` with "Cannot find module"
  (2026-09-06). Presence is judged by `node_modules/<name>/package.json`, not
  `require.resolve`: a package whose `exports` map has no `"."` entry (the
  MCP SDK) and a types-only `@types/*` package both throw from resolve even
  when correctly installed. `optionalDependencies` are skipped on purpose.
- `devLoop.mjs` is the `npm run dev` entrypoint: it runs `preflight.mjs`, then
  `orchestrate.mjs`, and runs both AGAIN (fresh processes) whenever the
  orchestrator exits with `RESTART_EXIT_CODE` (75) — the dev console's soft
  restart. It is the one dev process a soft restart does not replace, so keep it
  tiny. On a soft restart a failed preflight repair continues on the current
  node_modules (the previous stack ran on them, and agents are waiting to be
  re-adopted) instead of stopping; the first boot keeps the strict rule. Ctrl+C
  between two stacks POSTs the terminal-server `/shutdown` itself, since no dev
  runner is alive to.
- `orchestrate.mjs` is the boot sequence: backend first, wait for `/api/health` or timeout, then frontend. Its extra duties — the dev-console commands and the root/frontend dependency watch — live in helpers (`orchestrate/devControl.mjs`, `depsWatch.mjs`); keep them there.
- **Dev console commands** (`orchestrate/devControl.mjs`, one-line hint printed at
  boot): `r` + Enter = **soft restart** — the backend dev runner and vite stop
  and the whole stack (preflight, orchestrator, `backend/scripts/dev.mjs`, vite)
  starts again from current scripts/deps, but the detached terminal-server is
  NOT shut down, so the next backend re-adopts every live agent pty exactly as
  after an ordinary `tsc -w` restart. `d` = **detach**: the same stop, then exit
  (the next `npm run dev` re-adopts the agents; the terminal-server exits on its
  own once it has no sessions and no backend). `i` = re-check deps now (forces a
  retry of a failed install). `r`/`d` refuse while a live `run.lock` is held and
  name it; `r!`/`d!` go ahead. Ctrl+C is unchanged: a full stop that ends every
  agent. A soft restart does not replace a *stale* terminal-server with live
  sessions (that still only happens when it is idle) and cannot free a native
  module it has loaded (node-pty).
  - Commands are read only from a real console (`process.stdin.isTTY`);
    `LATTICE_DEV_CONSOLE_STDIN=1` opts a piped stdin in, for a test driver that
    types them (an isolated dev-stack e2e on alternate ports: `PORT`,
    `TERMINAL_PORT`, `LATTICE_FRONTEND_PORT`/`LATTICE_BACKEND_PORT`, an isolated
    `HOME`/`USERPROFILE` — the orchestrator's health URL follows `PORT`).
  - Commands are **lines, not raw keypresses**: raw mode clears the console's
    `ENABLE_PROCESSED_INPUT` on Windows — a per-console setting — so Ctrl+C
    would stop reaching `dev.mjs` / `dist/index.js` as the console break their
    full-stop path depends on.
  - The orchestrator is the console's ONLY reader: the backend child gets a
    **control pipe** as stdin (`stdin: 'pipe'` + `LATTICE_DEV_CONTROL=stdin`,
    which `dev.mjs` deletes from its env on read so it never reaches agent
    ptys) carrying `soft-stop` / `deps-recheck` lines; vite gets a pipe that is
    never written (which drops vite's own h/r/o/q shortcuts — two readers of one
    console split its lines unpredictably). Never `'ignore'` for vite: it closes
    its server when stdin ENDS (its parent-death signal), and an ignored stdin
    ends at once.
  - Why the soft stop cannot take the agents with it: `dev.mjs` kills
    `dist/index.js` with a plain `kill()` (TerminateProcess, not a tree kill),
    and the orchestrator waits for `dev.mjs` to exit on its own
    (`SOFT_STOP_TIMEOUT_MS`) rather than `taskkill /T`-ing a tree that, while the
    backend that spawned the terminal-server is alive, still contains it (a
    `detached` child keeps its parent pid). Only a runner that ignores the
    request for 20 s is tree-killed.
- **Dependency changes after boot** (`depsWatch.mjs`, shared with
  `backend/scripts/dev.mjs`; typed in `depsWatch.d.mts`, unit-tested in
  `backend/src/__tests__/depsWatch.test.ts`). Each workspace's `package.json` +
  `package-lock.json` are watched (the directory, debounced 2 s — git and
  editors replace files by rename). The trigger is a `depsCheck.mjs` MISMATCH,
  never a file event alone (npm rewrites its own lockfile), and the fix is
  `npm install` with cwd = the workspace (never `--prefix`). Owners: root and
  frontend here (vite is stopped for the install — on Windows a loaded esbuild
  binary can't be replaced — and restarted after, success or not; the backend
  and agents are untouched); backend in `dev.mjs`. A failed install is logged
  with a hint (a locked node-pty points at the terminal-server and a full stop
  when agents are idle — a soft restart can't free it), recorded in
  `dev-runner.log` as `npm-install-<workspace>`, and not retried until the
  files change again, or after 3 failures in a row at all; `i` forces a retry.
- **Children are spawned with their own `cwd`, never `npm --prefix <dir> run`.**
  Both forms run the script with cwd = the package dir, but `--prefix` also sets
  npm's `prefix` config, whose primary meaning is "the location to install
  global items". npm exports its whole resolved config to every run-script as
  `npm_config_*`, and the backend hands its environment wholesale to every pty,
  so `--prefix backend` made `npm install -g` in ANY Lattice terminal, in ANY
  project, install into `<latticeRoot>/backend` (present since the initial
  commit; fixed 2026-08-25). `backend/src/terminal/envSetup.ts`
  (`scrubInheritedNpmEnv`) is the matching defence at the pty boundary. Do not
  reintroduce `--prefix` here. On Windows `startChild` hands the shell ONE
  constant command string (`npm run dev`), never args + `shell: true` — that
  combination prints Node's DEP0190 deprecation warning at every boot (the
  same rule `preflight.mjs` and `backend/scripts/dev/deps.mjs` follow); the
  args are validated as bare script names before being joined.
- Orchestrator helpers live in `scripts/orchestrate/`: child spawning/prefixing/shutdown in `children.mjs`, health polling in `health.mjs`, Vite proxy ECONNREFUSED filtering in `logFilter.mjs`, shared constants/colors in `config.mjs`, crash bookkeeping in `devLog.mjs`, and the dev-console commands + orchestrator↔dev-runner control protocol in `devControl.mjs` (unit-tested in `backend/src/__tests__/devControl.test.ts`).
- `devLog.mjs` keeps the tail of each child's output in memory and appends it to `~/.lattice/logs/dev-runner.log` whenever a child exits abnormally. The backend and terminal-server write their own crash files (`backend/src/crashLog.ts`), but that only covers deaths they are alive to observe — a `taskkill`, an OS OOM-kill, a hard native fault, or vite falling over leaves nothing, and `npm run dev` output lives only in the user's terminal. `recordExit` also takes a `detail` string for a decoded cause of death; without it a Windows fault lands here as a bare `code=3221225477`, which reads like an ordinary non-zero exit rather than "the OS killed it for a bad pointer". **This orchestrator only ever sees its own two children** (`backend/scripts/dev.mjs` and vite) — never the `dist/index.js` that the first of those spawns, which is the process that actually crashes. That second supervisor lives in `backend/scripts/dev/backendLifecycle.mjs` and imports `recordExit` from here; keep the two in step.
- `consoleSink.mjs` is how the orchestrator writes to the console, and it must stay that way. `process.stdout.write` blocks the event loop (Node forces blocking TTY writes), Windows pauses a console for as long as a text selection is open, and this process is the only reader of the `[backend]` / `[frontend]` pipes — so one stray click in the dev window stopped it draining them, the children's pipes filled, and the backend froze solid at 0% CPU for hours (2026-08-20). Writes go through async `fs.write()` on the thread pool with a bounded queue; the console can pause without anything downstream noticing. A short write's unwritten tail and an `EAGAIN`-refused chunk (a non-blocking piped fd with a full pipe) go back to the FRONT of the queue — the latter retried after 25 ms — never the back (that split a line around newer output) and never dropped (`backend/src/__tests__/devConsoleSinkWriteErrors.test.ts`). See `backend/src/consoleSink.ts` for the backend's own copy and the full incident note.
- Preserve the visible dev-console contract when editing: `[backend]` / `[frontend]` prefixes and colors, Vite proxy-error suppression, and Windows `taskkill /T` process-tree shutdown.
- `opengrep-pin.mjs` is the maintainer tool for bumping the Opengrep engine
  Lattice installs for users (`node scripts/opengrep-pin.mjs vX.Y.Z
  [--cache-dir <dir>] [--cosign <path>]`). It downloads every release asset
  named in `backend/src/opengrep/versions.ts`, verifies each one's Sigstore
  `.sig`/`.cert` with `cosign verify-blob` against the Opengrep release-workflow
  identity, and only then rewrites the SHA-256 pin block. **It refuses to run
  without a working `cosign`** — a pinned digest is what lets every user skip
  the signature check, so the check must have actually happened. Nothing it
  downloads is ever committed (see `backend/src/opengrep/CLAUDE.md`).
- `soak/selfHostSoak.mjs` — the **self-hosting soak**: does a workflow survive
  its backend being hard-killed over and over mid-flight (what happens when
  Lattice merges into its own repo and every merge restarts the backend)?
  `node scripts/soak/selfHostSoak.mjs [--tasks 8] [--chaos 10-30] [--down 0-4]
  [--timeout 25] [--no-chaos] [--keep]`. Everything is isolated in a temp dir:
  a backend from this checkout's `backend/dist` (keep `npm run dev` running or
  build first) on `PORT` 5484 / `TERMINAL_PORT` 5485 with its own `HOME` and
  `TEMP` (the backend prunes `projects.json` entries under its temp dir as test
  junk, which would hide the soak project from restart recovery); a throwaway
  git project where half the tasks append to the same file (so every later
  merge conflicts and runs the resolver flow); the post-merge hook on; and a
  Start → Merge → Run tests → Push workflow. `soak/fakeClaude.mjs` stands in
  for `claude` (put first on every pty's PATH via `LATTICE_PTY_PATH_PREPEND` —
  the registry PATH otherwise outranks an inherited one): it makes the edit /
  resolves the conflict / writes the test summary a real agent would, then runs
  the exact Stop hook Lattice installed and idles like an interactive session.
  No tokens, deterministic. It checks: the run completed, every task reached
  QA, main holds every line with no conflict markers, no worktree left, the
  callback outbox drained, exactly one push session. Exit 0 = all held; a
  failing run keeps its dir (`backend-<n>.log` per incarnation,
  `fake-agents.jsonl`, `home/.lattice`).
