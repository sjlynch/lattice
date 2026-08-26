# Root scripts

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
  reintroduce `--prefix` here.
- Orchestrator helpers live in `scripts/orchestrate/`: child spawning/prefixing/shutdown in `children.mjs`, health polling in `health.mjs`, Vite proxy ECONNREFUSED filtering in `logFilter.mjs`, shared constants/colors in `config.mjs`, and crash bookkeeping in `devLog.mjs`.
- `devLog.mjs` keeps the tail of each child's output in memory and appends it to `~/.lattice/logs/dev-runner.log` whenever a child exits abnormally. The backend and terminal-server write their own crash files (`backend/src/crashLog.ts`), but that only covers deaths they are alive to observe — a `taskkill`, an OS OOM-kill, a hard native fault, or vite falling over leaves nothing, and `npm run dev` output lives only in the user's terminal. `recordExit` also takes a `detail` string for a decoded cause of death; without it a Windows fault lands here as a bare `code=3221225477`, which reads like an ordinary non-zero exit rather than "the OS killed it for a bad pointer". **This orchestrator only ever sees its own two children** (`backend/scripts/dev.mjs` and vite) — never the `dist/index.js` that the first of those spawns, which is the process that actually crashes. That second supervisor lives in `backend/scripts/dev/backendLifecycle.mjs` and imports `recordExit` from here; keep the two in step.
- `consoleSink.mjs` is how the orchestrator writes to the console, and it must stay that way. `process.stdout.write` blocks the event loop (Node forces blocking TTY writes), Windows pauses a console for as long as a text selection is open, and this process is the only reader of the `[backend]` / `[frontend]` pipes — so one stray click in the dev window stopped it draining them, the children's pipes filled, and the backend froze solid at 0% CPU for hours (2026-08-20). Writes go through async `fs.write()` on the thread pool with a bounded queue; the console can pause without anything downstream noticing. See `backend/src/consoleSink.ts` for the backend's own copy and the full incident note.
- Preserve the visible dev-console contract when editing: `[backend]` / `[frontend]` prefixes and colors, Vite proxy-error suppression, and Windows `taskkill /T` process-tree shutdown.
