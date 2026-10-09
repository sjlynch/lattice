# Root scripts

Root dev orchestration: `npm run dev` = `devLoop.mjs` → `preflight.mjs` →
`orchestrate.mjs` (backend first, wait for `/api/health`, then vite). The
backend's own runner (restart deferral while a `run.lock` is held, drain
handshake, backend deps) is `backend/scripts/dev.mjs` —
[backend/scripts/CLAUDE.md](../backend/scripts/CLAUDE.md).

## Map

- `devLoop.mjs` — the `npm run dev` entrypoint: runs `preflight.mjs`, then
  `orchestrate.mjs`, and runs both AGAIN (fresh processes) whenever the
  orchestrator exits with `RESTART_EXIT_CODE` (75) — the soft restart.
- `preflight.mjs` — self-heals `node_modules` across root / backend /
  frontend before the orchestrator starts.
- `depsCheck.mjs` (+ `.d.mts`) — the shared declared-vs-locked-vs-installed
  check, used by preflight, `depsWatch.mjs` and `backend/scripts/dev/deps.mjs`.
- `depsWatch.mjs` (+ `.d.mts`) — post-boot dependency watch, shared with
  `backend/scripts/dev.mjs`; the `npm install` runner is `npmInstall.mjs`
  (re-exported from it).
- `orchestrate.mjs` — the boot sequence and console-command wiring. Its
  helpers (child spawn/kill, health poll, log prefixing, console sink, crash
  log, control protocol) live in `orchestrate/` — keep them there; see
  [orchestrate/CLAUDE.md](orchestrate/CLAUDE.md).
- `workspace.mjs` — the root `npm run typecheck` / `npm test` /
  `npm run test:file -- <path or module>`: runs each package's own
  `package.json` script with that package as cwd (node spawned directly — no
  shell, no `--prefix`), backend then frontend.
- `testReporter.mjs` — the node:test reporter both packages' tests use: failing
  tests with their error, captured console output of failing files only, one
  summary line. Agents read test output; there is deliberately no verbose mode.
- `opengrep-pin.mjs` — maintainer tool that bumps the Opengrep engine pin.
- `soak/` — the self-hosting soak; see [soak/CLAUDE.md](soak/CLAUDE.md).

Tests: named after the module — grep it in `backend/src/__tests__/`.

## Dev console commands

One-line hint printed at boot; implemented in `orchestrate/devControl.mjs`.

- `r` + Enter = **soft restart**: the backend dev runner and vite stop and the
  whole stack (preflight, orchestrator, `backend/scripts/dev.mjs`, vite) starts
  again from current scripts/deps, but the detached terminal-server is NOT
  shut down, so the next backend re-adopts every live agent pty exactly as
  after an ordinary `tsc -w` restart.
- `d` = **detach**: the same stop, then exit. The next `npm run dev` re-adopts
  the agents; the terminal-server exits on its own once it has no sessions
  and no backend.
- `i` = re-check deps now (forces a retry of a failed install).
- `r` / `d` refuse while a live `run.lock` is held and name it; `r!` / `d!`
  go ahead.
- Ctrl+C is the full stop that ends every agent.
- A soft restart does not replace a *stale* terminal-server that has live
  sessions (that still happens only when it is idle) and cannot free a native
  module it has loaded (node-pty).

## Invariants

- **`devLoop.mjs` is the one dev process a soft restart does not replace —
  keep it tiny.** On a soft restart a failed preflight repair continues on
  the current `node_modules` (the previous stack ran on them, and agents are
  waiting to be re-adopted); the first boot keeps the strict rule. A Ctrl+C
  between two stacks POSTs the terminal-server `/shutdown` itself, since no
  dev runner is alive to.
- **Preflight compares what each workspace's `package.json` declares**
  (`dependencies` + `devDependencies`) and the version its lockfile pins
  against what is installed. Don't reintroduce a hand-picked package sample:
  it let a newly pulled dependency pass preflight and die in the backend's
  first `tsc` with "Cannot find module". Presence is judged by
  `node_modules/<name>/package.json`, not `require.resolve` — a package whose
  `exports` has no `"."` entry (the MCP SDK) and a types-only `@types/*` both
  throw from resolve when correctly installed. `optionalDependencies` are
  skipped on purpose.
- **Dependency changes after boot** (`depsWatch.mjs`): each workspace's
  `package.json` + `package-lock.json` directory is watched, debounced 2 s
  (git and editors replace files by rename). The trigger is a `depsCheck.mjs`
  MISMATCH, never a file event alone (npm rewrites its own lockfile); the fix
  is `npm install` with cwd = the workspace. Root and frontend are owned
  here — vite is stopped for the install (Windows can't replace a loaded
  esbuild binary) and restarted after, success or not; the backend and
  agents are untouched. The backend workspace is owned by `dev.mjs`. A failed
  install is logged with a hint (a locked node-pty points at the
  terminal-server and a full stop when agents are idle — a soft restart can't
  free it), recorded in `dev-runner.log` as `npm-install-<workspace>`, and not
  retried until the files change again, or at all after 3 failures in a row;
  `i` forces a retry.
- **Children run with their own `cwd`, never `npm --prefix <dir> run`.**
  `--prefix` also sets npm's `prefix` config ("where global installs go"),
  npm exports its resolved config to every run-script as `npm_config_*`, and
  the backend hands its environment to every pty — so `npm install -g` in ANY
  Lattice terminal, in any project, installed into `<latticeRoot>/backend`.
  `backend/src/terminal/envSetup.ts` (`scrubInheritedNpmEnv`) is the matching
  defence at the pty boundary. Do not reintroduce `--prefix`, here or in
  `npmInstall.mjs`.
- **On Windows npm is spawned as ONE constant command string**, never
  args + `shell: true` (Node's DEP0190 warning at every boot) — preflight,
  `npmInstall.mjs`, `orchestrate/children.mjs` `startChild` and
  `backend/scripts/dev/deps.mjs`.
- **`opengrep-pin.mjs` refuses to run without a working `cosign`** —
  `node scripts/opengrep-pin.mjs vX.Y.Z [--cache-dir <dir>] [--cosign <path>]`
  downloads every release asset named in `backend/src/opengrep/versions.ts`,
  verifies each `.sig`/`.cert` with `cosign verify-blob` against the Opengrep
  release-workflow identity, and only then rewrites the SHA-256 pin block. A
  pinned digest is what lets every user skip the signature check, so the
  check must have actually happened. Nothing it downloads is ever committed
  (`backend/src/opengrep/CLAUDE.md`).
