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
- `orchestrate.mjs` is the `npm run dev` entrypoint. Keep it as the boot sequence only: backend first, wait for `/api/health` or timeout, then frontend.
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
- Orchestrator helpers live in `scripts/orchestrate/`: child spawning/prefixing/shutdown in `children.mjs`, health polling in `health.mjs`, Vite proxy ECONNREFUSED filtering in `logFilter.mjs`, shared constants/colors in `config.mjs`, and crash bookkeeping in `devLog.mjs`.
- `devLog.mjs` keeps the tail of each child's output in memory and appends it to `~/.lattice/logs/dev-runner.log` whenever a child exits abnormally. The backend and terminal-server write their own crash files (`backend/src/crashLog.ts`), but that only covers deaths they are alive to observe — a `taskkill`, an OS OOM-kill, a hard native fault, or vite falling over leaves nothing, and `npm run dev` output lives only in the user's terminal. `recordExit` also takes a `detail` string for a decoded cause of death; without it a Windows fault lands here as a bare `code=3221225477`, which reads like an ordinary non-zero exit rather than "the OS killed it for a bad pointer". **This orchestrator only ever sees its own two children** (`backend/scripts/dev.mjs` and vite) — never the `dist/index.js` that the first of those spawns, which is the process that actually crashes. That second supervisor lives in `backend/scripts/dev/backendLifecycle.mjs` and imports `recordExit` from here; keep the two in step.
- `consoleSink.mjs` is how the orchestrator writes to the console, and it must stay that way. `process.stdout.write` blocks the event loop (Node forces blocking TTY writes), Windows pauses a console for as long as a text selection is open, and this process is the only reader of the `[backend]` / `[frontend]` pipes — so one stray click in the dev window stopped it draining them, the children's pipes filled, and the backend froze solid at 0% CPU for hours (2026-08-20). Writes go through async `fs.write()` on the thread pool with a bounded queue; the console can pause without anything downstream noticing. See `backend/src/consoleSink.ts` for the backend's own copy and the full incident note.
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
