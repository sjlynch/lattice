# backend/src/mcp

The MCP control plane. Lattice is the single place a user curates/toggles MCP
servers; it injects the enabled set into the Claude, Codex and Pi sessions it
spawns. Policy is **resolved in the main backend** (`registry.ts`) and
**applied** per harness at spawn. Full design: `plans/mcp-integration.md` +
`plans/mcp-codex-pi-harness-plan.md` (gitignored).

## Per-harness mechanism

All spawns funnel through `proxyCreateSession` → `resolveHarnessSpawnBody`
(`terminalServerClient/createSession.ts`); the core is the harness-neutral
`resolveMcpEntries(catalog, settings, secrets, harness, ctx)`, then one shaper per harness.

| Harness | Shaper → output | Applied where / how |
|---|---|---|
| Claude | `resolveClaudeServers` / `claudeServerConfig.ts` → `mcpServers` map | Backend ships it in the `POST /sessions` body (`managedMcpServers`, + `disableClaudeMemory`); terminal-server `createSessionHandler.ts` calls `applyClaudeProjectConfig(cwd, {managed})` (`claudeTrust.ts`) into `~/.claude.json` `projects[<cwd>]` microseconds before `pty.spawn` (after any clobber by an exiting Claude). Also persisted into `projects[<projectRoot>]` — see "Injection sites" |
| Codex | `resolveCodexServers` / `codexServerConfig.ts` → `-c "mcp_servers.lattice_<id>={…}"` inline-TOML strings + secret env | Terminal-server `configureCodexProjectMcp` (`terminal/codexTrust.ts`) turns each into a `--config` flag referencing an env var, so braces/quotes never enter shell source. Never writes `~/.codex/config.toml` |
| Pi | `resolvePiServers` / `piServerConfig.ts` → `.pi/mcp.json` server map + secret env | The **backend** writes `<cwd>/.pi/mcp.json` + the `.pi/extensions/lattice-mcp.ts` loader shim at the chokepoint (`piMcp.ts` `applyPiMcpForSpawn`) — they are cwd files, so must exist before Pi starts. See `../piMcp/` |

- **Codex**: the dotted `-c` key MERGES, so the user's own servers survive.
  Secrets ride the pty env by NAME: stdio → `env_vars=['VAR']`, HTTP header →
  `env_http_headers={Header='VAR'}` (value in pty env, never argv). A stdio
  secret's name is listed in `env_vars` **even with no stored value**: Codex
  starts a stdio server from a cleared env (small default set + `env` +
  `env_vars`), so that is the only way an ambient shell key reaches it.
- **Pi** has no native MCP: it loads the third-party `pi-mcp-adapter` (official
  Pi ≥0.74; private install under `~/.lattice/pi-mcp-adapter/`, never the user's
  global Pi config). `.pi/mcp.json` is reconciled with a `__latticeManagedMcp`
  marker so the user's servers survive. Each server gets `lifecycle: 'eager'` +
  `directTools: true` (individual tools with a warm metadata cache; a cold
  worktree falls back to the always-present `mcp()` proxy tool). Stdio secrets
  are omitted from the file (inherited via env); HTTP-header secrets are
  `${VAR}` refs (naming shared with Codex via `secretHeaderEnvVar`). Pi ≥0.74
  reads cwd `.pi/extensions/` only in a *trusted* project, so Lattice spawns Pi
  with **`--approve`** (`agentCommandBuilder.ts`; trusts the cwd for that run,
  never persisted) — without it every cwd shim (MCP, pi-subagents, completion)
  is inert.

**v1 coverage — Lattice-created launches only** (task run/resume, workflow step,
prompt customization, post-merge hook, sidebar launcher). The sidebar launcher
reaches the chokepoint via **`POST /api/terminals`** (`routes/terminals.ts`),
which pre-creates the pty; without it a sidebar terminal connects serverlessly
to `/ws/terminal` (pty built from WS query params) and Codex/Pi get no MCP —
only Claude survives, via the persistent project-root reconcile. A harness typed
into an already-open plain shell is not observable, and Lattice deliberately
does not write a tracked `.codex/config.toml` or a proactive project-root
`.pi/mcp.json` to cover it. (Startup-configured harness terminals also stay
serverless for now — see `frontend/src/components/sidebar/CLAUDE.md`.)

## Policies

- **Third-party servers are off by default, three independent switches each.**
  Claude: `UserSettings.mcpOverrides`; Codex/Pi: `mcpHarnessOverrides.{codex,pi}`.
  Enabling for one harness never loads it into another; `McpHarnessSupport
  {claude,codex,pi}` gates which harnesses can offer a server. `harnessToggleOn`
  = explicit boolean first, else `entry.defaultEnabled`.
- **`lattice` is the one `defaultEnabled: true` entry** (`../latticeMcp/`). None
  of the all-off reasons apply: Lattice's own code, no key, no telemetry, talks
  only to the local backend — and the agents that need it most (worktree agents,
  workflow planners) have nobody present to configure it. **Never set
  `defaultEnabled` on a third-party entry.** Safeguards:
  - `resolveMcpEntries` DROPS it when `ctx.projectPath` is absent (every tool
    needs `LATTICE_PROJECT`; no tools beats eleven that fail).
  - Opt-out is a real per-harness switch (`mcpOverrides.lattice = false` /
    `mcpHarnessOverrides.<codex|pi>.lattice = false`); the MCP tab renders it on
    via `overrides[id] ?? !!defaultEnabled` (`frontend/.../settings/McpTab.tsx`).
  - Overrides can't re-point it: `settingsValidation.ts` simply never copies
    `defaultEnabled`/`command`/`args` off an untrusted override or custom entry
    (no lattice-specific code), so a custom server can never acquire the flag.
  - **Pi caveat**: "on by default" means every Lattice-spawned Pi session loads
    the third-party `pi-mcp-adapter` (already installed at boot; files are
    gitignored/worktree-excluded). `mcpHarnessOverrides.pi.lattice = false`
    turns it off for Pi only.
- **`lattice` per-spawn env.** `resolveMcpEntries` emits a **clone** (never
  mutates the long-lived catalog array) with `env` merged from the context,
  filled identically for all harnesses by `withSpawnContext` in the four async
  resolvers (`effectiveMcpServers`, `resolveManaged{Claude,Codex,Pi}Servers`):
  `LATTICE_API_URL` (`ctx.apiUrl`), `LATTICE_PROJECT`
  (`canonicalProjectPath(ctx.projectPath)`, so the server's `canonicalProject`
  check compares like with like), and `LATTICE_TASK_ID` (`ctx.taskId`, only for
  task run/resume and the WORKTREE merge resolvers — never stash/snapshot
  resolvers; **omitted, never set empty**: the server registers `my_task` and
  defaults `append_summary`'s id exactly when it exists, and leaves out the
  board-management tools and `opengrep_ignore` — a permanent write to the
  project's Opengrep ignore lists that an untrusted worktree brief must not be
  able to trigger). An override's `env` IS
  tunable, so `shapeLatticeEntry` strips every `LATTICE_*` key from it first.
  `command` is **`process.execPath`**, not bare `node` (no shell, and the
  harness's PATH isn't ours); it is an absolute `.exe`, so `platformizeCommand`
  correctly leaves it unwrapped — `cmd /c` would break a path with a space.
- **Task-worktree scope → lattice-only.** `UserSettings.taskAgentsLatticeMcpOnly`
  (**default ON** — absent, or a corrupt settings file read as `{}`, counts as
  on). A task run/resume or worktree merge resolver gets ONLY `lattice` (nothing
  if `lattice` is off for that harness). Why: each idle stdio server is a
  `cmd /c` + conhost + node/uv tree (~100–180 MB) per agent. Decided once per
  spawn by `latticeOnlyMcpApplies`, which needs all three: spawn option
  `mcpScope: 'task-worktree'` (set by `routes/tasks/harnessFactory.ts`,
  `routes/tasks/mergeResponses.ts`, `mergeRuns/resolverSpawn/spawn.ts`), the
  setting, and a cwd strictly under `~/.lattice/worktrees/`. **That cwd guard is
  load-bearing**: at a project root `projects[<cwd>]` is the user's own persisted
  set, and restricting it would strip their servers. Resolver side:
  `McpResolveContext.latticeOnly`. The chokepoint reads settings once
  (`preloadedSettings`); the scope persists on `TerminalLaunch.mcpScope` so a
  relaunched tab keeps it. Per harness:
  - **Claude** — the usual reconcile AND `--strict-mcp-config
    --mcp-config="<file>"` (ignores user-scope and repo `.mcp.json` servers too),
    appended in the BACKEND like `--session-id` (a stale executor would ignore a
    new wire field). The `=` form matters: `--mcp-config` is variadic. File:
    `~/.lattice/per-project/<hash>/mcp-config/claude-task-<id>.json` (0600,
    atomic, rewritten every spawn, >30 days pruned; empty `{"mcpServers":{}}`
    when `lattice` is off), path written with forward slashes; flags skipped
    (unscoped, warned) if the home path has a char no shell quotes portably. The
    registry keeps the ORIGINAL command, so flags never stack on relaunch.
  - **Codex** — only `mcp_servers.lattice_lattice`, preceded by
    `mcp_servers.<name>.enabled=false` for each bare-key server in
    `$CODEX_HOME/config.toml` (default `~/.codex`) and `<cwd>/.codex/config.toml`.
    `-c 'mcp_servers={}'` does NOT work (the `-c` layer merges over config.toml,
    so an empty table removes nothing — verified on codex-cli 0.155.1), and
    disabling a name Codex doesn't know fails startup ("invalid transport"),
    hence names read from the files.
  - **Pi** — `.pi/mcp.json` gets only `lattice`, but `pi-mcp-adapter` also merges
    `~/.config/mcp/mcp.json`, `~/.pi/agent/mcp.json`, a repo `.mcp.json` and
    `imports` with no off switch, so only Lattice-managed servers are restricted.
- **Playwright has two independent toggles** (`resolverPolicy.ts`
  `resolvePlaywright`; Claude only — Codex/Pi treat it as a plain toggle, no QA
  scope). The GLOBAL toggle (`mcpOverrides.playwright` /
  `mcpHarnessOverrides.{codex,pi}.playwright`) reaches every Lattice session +
  the project-root reconcile, **headless unless** the cross-harness
  `mcpPlaywrightHeaded` ("Show browser") is on. `qaPlaywright` is QA-runs-ONLY
  (`ctx.isQaRun`, set by the QA-run spawn alone): its `headless` is the QA lane's
  eye switch and on a QA run it wins over the global toggle —
  **`mcpPlaywrightHeaded` never touches a QA run**. Catalog args always include
  **`--isolated`** (not optional): otherwise `@playwright/mcp` shares one
  persistent profile and a second concurrent instance dies with "Browser is
  already in use". The shapers append `--headless` when resolved headless.
- **Secrets live only in `~/.lattice/mcpSecrets.json`** (`0600`, own file, so
  settings endpoints never touch secret bytes; **raw values never cross backend
  → browser**) and reach a server by env NAME — pty env or `${VAR}`/env-name
  refs, **never argv and never written into harness config**.
- **A built-in override may TUNE a server but never re-point what it runs**
  (`settingsValidation.ts` / `overrideSecurity.ts`, see Modules).

## Modules

- `catalog.ts` — built-in catalog in code (`BUILTIN_MCP_SERVERS`: `lattice`,
  playwright, brave-search, blender) + `McpServerEntry`. Package names live here
  so churn is a code change, not a data migration.
- `retiredServers.ts` — `RETIRED_BUILTIN_MCP_IDS` (leaf, no imports):
  `chrome-devtools`, `context7` (removed 2026-09). `userSettings/storage.ts`
  strips stale toggles for them on read (else a leftover `context7: true` would
  switch on a custom server imported under that id); the importer renames such
  an import to `<id>-imported`.
- `registry.ts` — resolver facade: `mergedCatalog()` (built-ins ⊕
  `mcpBuiltinOverrides` ⊕ `mcpCustomServers`), `effectiveMcpServers` +
  `resolveManaged*Servers` (inputs via `loadResolveInputs`, ctx via
  `withSpawnContext`); re-exports the two modules below — import from here.
- `resolveEntries.ts` — pure core: `resolveMcpEntries`, `harnessToggleOn`,
  `shapeLatticeEntry`, and the public `McpResolveContext` (`isQaRun`,
  `projectPath`, `apiUrl`, `taskId`, `latticeOnly`) / `ResolveSettings`.
- `harnessResolvers.ts` — pure per-harness shapers
  (`resolve{Claude,Codex,Pi}Servers`), `shapeOrSkip`, secret-env clash skip.
- `resolverPolicy.ts` — pure `resolvePlaywright` (two-scope policy above).
- `taskWorktreeScope.ts` — `latticeOnlyMcpApplies`, the Claude strict
  `--mcp-config` writer/flags, `codexUserServerDisableArgs`.
- `claudeServerConfig.ts` — pure: `secretEnvVarsFor` (`requiresSecret.envVar` ⊕
  `secretEnvVars`), `toClaudeConfig` (stored secrets via env / `secretHeaders`,
  `--headless`, win32 wrap). Kept apart from `claudeInject.ts` so resolver logic
  stays out of the terminal-server's apply path + fingerprint.
- `codexServerConfig.ts` — pure `toCodexServerConfig` → one `-c` override +
  pty env; `safeCodexServerId` namespaces ids. A JSON string is a valid TOML
  basic string, so `JSON.stringify` renders strings/arrays.
- `piServerConfig.ts` — pure `toPiServerConfig` → one adapter server config +
  pty env.
- `claudeInject.ts` — pure: `reconcileMcpServers` (add managed, strip
  previously-managed via the `__latticeManagedMcp` marker, never touch the
  user's entries) + `platformizeCommand` (wrap `WIN_SHIM_COMMANDS` —
  `npx`/`uvx`/`pnpm`/`bunx`/… — in `cmd /c` on win32; the MCP SDK spawns without
  a shell, so bare `npx` ENOENTs; all three shapers call it). **Every wrapped arg
  goes through `escapeCmdArgument`** (unescaped `&`/`|`/`>`/`%VAR%` was command
  injection). Built around what the transport actually hands cmd (libuv for
  Claude/Pi, Rust std for Codex — CommandLineToArgvW quoting, no
  `windowsVerbatimArguments`): a whitespace-free arg arrives verbatim and is
  caret-escaped, **doubled** for a `.cmd`/`.bat` target (`windowsShimIsBatch`,
  PATH × PATHEXT, assumes batch when unresolved); a whitespace arg arrives
  quoted and passes untouched. Unrepresentable args (any `"`, a control char,
  whitespace with `%`/`!`) throw `UnsafeCmdArgumentError` and `shapeOrSkip`
  skips THAT server with a warning. Ordinary args are byte-identical to before.
  The line starts `set NoDefaultCurrentDirectoryInExePath=1&&<cmd>` (else cmd
  searches the session cwd before PATH, so a repo-root `npx.cmd` would run) —
  in-line, not in `env`, so "absent `env` = inherit" is unchanged. Pinned
  against real cmd.exe in `__tests__/mcp.inject.test.ts`.
- `settingsValidation.ts` — parsers for the UNTRUSTED `mcpCustomServers` /
  `mcpBuiltinOverrides` off `PATCH /api/global-settings`:
  `sanitizeCustomServers` / `sanitizeBuiltinOverrides` keep only resolver-read
  fields; `applyBuiltinOverride` re-pins id/command/url and allows
  **additive-only args** (append a Playwright `--browser`, never swap the package).
- `overrideSecurity.ts` — `isUnsafeOverrideArg`: an appended flag that points at
  a binary (`--executable-path`/`--executablePath`/`--browser-executable`/
  `--chrome-path`/`--browser-path`, `--chrome-arg` (e.g.
  `--renderer-cmd-prefix`), Playwright `--config <file>` (can set
  `launchOptions.executablePath`)), in `--flag value` or `--flag=value` form,
  case-/dash-/underscore-insensitive, rejects the whole override (catalog args
  stand). `sanitizeOverrideEnv`: env denylist — `NODE_OPTIONS`, `LD_PRELOAD`,
  `PATH`, `npm_config_*`, `uv_*`/`pip_*`, `PYTHONPATH`-style startup vars,
  CA-bundle/proxy vars that would MITM the package fetch, ….
- `secrets.ts` — `mcpSecrets.json` I/O; `redactSecrets()` → booleans,
  `secretHints()` → `••••<last4>` (no tail under 12 chars). Ids/var names
  `__proto__`/`constructor`/`prototype` are refused on write and dropped on read
  (as plain-object keys they reached Object.prototype — `constructor` + `keys`
  replaced the process-wide `Object.keys`).
- `validators.ts` — `validateMcpServer` behind `POST /api/mcp/validate` (v1:
  Brave one-search probe).
- `importConfigs.ts` — orchestrator (`scanImportableServers`/`applyImport` +
  dedupe) over `import/` (`normalize.ts`, `secretDetection.ts`, `codexToml.ts`,
  `sources.ts` — see `import/CLAUDE.md`). Literal secret-looking **env AND
  HTTP-header** values go to the secrets file, off the entry (`secretEnvVars` /
  `secretHeaders`, re-injected at spawn); references (`${input:…}`, Codex
  `bearer_token_env_var`) are recorded with no value. A secret embedded in a
  `url` / `args` is redacted in the scan and the server is refused on apply.
- `../latticeMcp/` — the other half of `lattice`: the stdio server (board tools
  + Opengrep tools; `opengrep_ignore` outside task worktrees only) and
  `entryPath.ts`, which `catalog.ts` calls to bake the
  compiled entry into the entry's `args`. See its `CLAUDE.md`.

## Injection sites — resolve in the backend, apply in the terminal-server

The detached terminal-server **never imports the resolver**. Its runtime files
are content-fingerprinted; policy living there would make every policy edit
force a respawn that **kills every running agent** (or run stale). So policy
changes are backend-only; the terminal-server is a dumb executor.
`claudeTrust.ts` (the apply mechanism) imports only `claudeInject.ts` and IS in
the fingerprint, so a change to the write mechanism still takes effect.

- **Per-spawn** — `proxyCreateSession` resolves `resolveManagedClaudeServers(
  projectPath, {isQaRun})` + `isClaudeMemoryDisabled` and the terminal-server
  applies them (table above). One wiring point covers every backend spawn site;
  only the QA-run spawn passes `isQaRun: true`. Most cwds are ephemeral
  (worktrees/scratch), so these are throw-away `projects[<cwd>]` entries,
  re-resolved every spawn.
- **Project-root reconcile** — `POST /api/project-instrumentation`
  (`routes/projectClaude.ts` → `projectClaude/reconcile.ts`, on project open +
  settings save) applies `resolveManagedClaudeServers(project, {isQaRun:false})`
  to `projects[<projectRoot>]` — the one place Lattice intentionally writes the
  user's canonical entry, so GLOBAL servers reach a hand-started `claude` and
  sidebar terminals at the root (not from a subdirectory; Claude keys by launch
  cwd). The QA-only Playwright never lands there. With `lattice` on, that entry
  holds a **snapshot** of `process.execPath` + `dist/latticeMcp/server.js`: a node
  upgrade or moved checkout leaves a dead `lattice` there until the next project
  open / settings save. Accepted — reconciling every indexed project at boot
  would write `~/.claude.json` for hundreds of stale projects.
- `seedClaudeTrust(dir)` (worktree/scratch setup) is trust-only
  (`managed: null`), so it never strips MCP a later call added.

## Storage

- Definitions / overrides → `~/.lattice/globalSettings.json`
  (`mcpCustomServers`, `mcpBuiltinOverrides`) via `globalSettings.ts`.
- Per-project enables → `<project>/.lattice/userSettings.json`, read at spawn:
  `mcpOverrides`, `mcpHarnessOverrides`, `mcpPlaywrightHeaded`, `qaPlaywright`,
  `taskAgentsLatticeMcpOnly`.
- Secrets → `~/.lattice/mcpSecrets.json` (`0600`); redaction is structural.

## Adding a built-in server

Add an entry to `BUILTIN_MCP_SERVERS` in `catalog.ts`. Needs a key → set
`requiresSecret` (masked field + status chip + get-a-key link) and, if
testable, a `case` in `validators.ts`. Off by default automatically — **do not
set `defaultEnabled`**. Non-npm runners (`uvx`/`uv`) are already win32-wrapped
for all three harnesses via `WIN_SHIM_COMMANDS`.

Put what the entry can't express in **`runtimeNote`** (the only field the MCP
tab renders as a caveat — `runtime` is metadata nothing displays):
- **Out-of-band prerequisites.** `blender`: `uvx blender-mcp` is only a bridge to
  an addon socket on `localhost:9876`, so Blender must be OPEN with the "Blender
  MCP" addon on. No headless mode — the addon refuses `blender -b`, since
  commands run via `bpy.app.timers`, which background mode never pumps.
- **Optional keys.** Don't set `requiresSecret` for optional/elsewhere-configured
  keys (Blender's Sketchfab/Hyper3D keys live in its addon prefs); say so here.

**Switch off phone-home telemetry in `env`.** Agents run unattended and in
parallel, so per-tool-call reporting fires from every spawn. `env` is static
config every shaper propagates (Claude `~/.claude.json`, Codex TOML `env={…}`,
Pi `.pi/mcp.json`). `blender` sets `DISABLE_TELEMETRY` /
`BLENDER_MCP_DISABLE_TELEMETRY` / `MCP_DISABLE_TELEMETRY`. **Prefer the
server-side env kill switch over an in-app consent setting** (blender-mcp's
checkbox gates only the private payload, anonymous events ship regardless, and
`get_telemetry_consent` FAILS OPEN), and **set every accepted variable name** so
an upstream rename can't resume sending. Covered in `__tests__/mcp.harness.test.ts`.
