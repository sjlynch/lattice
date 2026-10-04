# backend/src/opengrep

Opengrep (the LGPL-2.1 community fork of Semgrep CE — a local, offline SAST
engine) as a Lattice **tool**: installed at the user's click, run as a child
process, and its findings handed to agents as a size-bounded markdown
**digest**. v1 surfaces it in two places: a workflow agent step with the
`opengrep` tool ticked (the scan runs before the harness spawns and the digest
lands beside `WORKFLOW_STEP.md`), and the `opengrep_scan` /
`opengrep_findings` MCP tools + `/api/opengrep/*` routes for any session.
The graph's Security chip also starts an explicit scan and colors files from
its stored results. It never scans on graph load, file changes or a timer.
QA-lane baseline diffs remain unimplemented.

## Licence boundary (read before adding anything here)

Lattice is MIT. The engine is LGPL-2.1; the default rule pack is MIT; the
optional broad pack is LGPL-2.1 + Commons Clause. Lattice's licence is
unaffected because of two rules, both enforced:

1. **No third-party binary or rule file is ever committed to this repository
   or bundled into a Lattice package.** The repo holds URLs, a pinned version,
   pinned commits and SHA-256 digests (`versions.ts`) — nothing else. Every
   download lands under `~/.lattice/opengrep/` on the user's machine, at the
   user's explicit click. Pinned by `__tests__/opengrepNoVendoredAssets.test.ts`,
   which walks `git ls-files`.
2. **Opengrep runs only as a separate process** (`spawnWithTimeout`), talking
   JSON over a file. It is never linked, loaded in-process or modified.

Process separation is not a derivative work under the LGPL, and the LGPL's
distribution obligations attach to whoever distributes the engine — GitHub's
release page, not Lattice. The Commons Clause on the archived pack forbids
*selling* a product whose value derives substantially from those rules; it
constrains a hosted-Lattice-as-a-service offering's use of that pack, not the
Lattice source. The pack is therefore USED as soon as it is installed
(`defaultEnabled: true` — it is the only pack with real TypeScript/Node/Express
coverage), while the DOWNLOAD stays an explicit click with the licence named
on the Settings row and a confirmation that spells out the no-resale condition.
Flipping the default changed nothing about Lattice's own licence; what must
never change is the "nothing is fetched without a click, nothing is
committed" pair. Lattice-authored rules (MIT) may live in the repo; third-party
ones may not. What would change the answer: shipping an installer that bundles
`opengrep.exe` (then Lattice distributes an LGPL work and must carry its
licence text + a source pointer) — keep it a runtime download.

## Modules

- `versions.ts` — the pins. `OPENGREP_VERSION` + per-asset `{sha256, bytes}`
  in a block that ONLY `scripts/opengrep-pin.mjs` writes: the script downloads
  every release asset, verifies each Sigstore `.sig`/`.cert` with
  `cosign verify-blob` against `OPENGREP_SIGNING_IDENTITY` (Opengrep's GitHub
  Actions release workflow), and refuses to write digests it could not verify.
  A user installing from the pins inherits that check without needing cosign.
  Also `OPENGREP_RULE_PACKS`: `qodana-mit` (MIT subset, default ON, prunes
  `jetbrains/` + `rules/lgpl/`) and `opengrep-archived` (the Dec-2024 Semgrep
  community snapshot — the only real TypeScript/React/Node/Express coverage,
  LGPL-2.1 + Commons Clause, used once installed; the install click is the
  informed step). Each pinned by full commit.
- `paths.ts` — `~/.lattice/opengrep/{bin/<version>/, downloads/, rules/<packId>/,
  state.json}`, `~/.lattice/per-project/<hash>/opengrep/` for scans, and the
  optional read-only `<project>/.opengrep/rules/`. Home-scoped, never inside
  a project tree.
- `state.ts` — `state.json`: installed binary (version/asset/digest) + per-pack
  (commit, rule counts, licence). Atomic + serialized. Display/scan reads are
  lenient (unreadable → empty); `updateOpengrepState` reads STRICTLY and refuses
  to write over an unreadable file (it would drop `binary` + the other packs).
- `platform.ts` — `pickOpengrepAsset({platform, arch, musl})`: the release
  asset for this machine, chosen automatically (Windows ARM64 → the x64 build
  under emulation, with a note; Linux musl via `/etc/alpine-release` or
  `/lib/ld-musl-*`). The user never picks.
- `detect.ts` — `resolveOpengrep()`: a PATH install always wins over the
  managed one (a package-manager copy is never overridden); each candidate is
  probed by running `--version`, which doubles as the antivirus-quarantine
  check. Memoized; a miss is re-probed on the next call.
- `install.ts` — `startOpengrepInstall()`: stream the asset to `downloads/`
  while hashing → byte count vs pin → digest vs pin → atomic rename into
  `bin/<version>/` → `--version` once (a vanished file reads as "your
  antivirus quarantined it") → state.json. Single-flight job snapshot for the
  Settings card — the pending start is cached SYNCHRONOUSLY, before the
  `chooseAsset` await (file I/O on Linux), so two quick POSTs share one
  download instead of racing `rm(target)` / `rename` and failing the loser's
  `--version` with a bogus "quarantined" message. The verified `.part` is
  removed when the mkdir / rename that should consume it throws (Windows
  EPERM/EBUSY), and every OTHER `downloads/*.part` (a transfer a restart killed)
  is swept when the next install starts. **Never at boot** — the user clicks
  Install.
- `rules.ts` — `installRulePack(id)`: `fetchPackCommit` → `prunePackTree`
  (the helpers below) → swap into place → state.json. Keeps the public facade,
  job snapshots and per-pack single-flight installs; re-exports the helpers
  and shared `RulePackError` so existing imports keep working. The swap moves the
  previous install aside first and puts it BACK if the new tree cannot be
  renamed in, so an update can never leave the user with no pack; stale
  `.tmp-<id>-*` / `.old-<id>-*` siblings from a killed install are swept at the
  start of the next install of THE SAME pack (never another pack's: installs of
  different packs may overlap). The swap + state
  write run under `withRulesMutation` (see `rulesGate.ts`), waiting for running
  scans first. In-flight installs are tracked per pack (`isRulePackInstalling`;
  the DELETE route answers 409 `installing`), and `removeRulePack` — itself a
  gated mutation that refuses (busy) while a scan runs — cancels a
  still-running install of that pack, which then discards its tree instead of
  swapping it in: a removal is never silently undone.
- `rulePackFetch.ts` — `fetchPackCommit`: `git init` + `fetch --depth 1 origin
  <commit>` + `checkout FETCH_HEAD`, then verifies HEAD matches the pin and
  removes `.git`. Content-addressed (tarball bytes are not stable); invoked
  only by a requested install. Git has a 5-minute timeout per command and
  `GIT_TERMINAL_PROMPT=0` / `GCM_INTERACTIVE=never` so credential prompts fail fast.
- `rulePackTree.ts` — `prunePackTree`: keep only `*.yaml`/`*.yml` with a
  top-level `rules:` key, excluding `*.test.yaml`, plus root LICENSE/README;
  drop the pack's `prune` folders, dot dirs, tests and scripts, counting files
  and rule ids. `sweepStalePackDirs` removes only the same pack's `.tmp`/`.old`
  siblings with a numeric suffix guard, preserving overlapping sibling installs.
- `rulePackError.ts` — dependency-free `RulePackError`, shared by the fetch
  helper and lifecycle facade without an import cycle.
- `rulesGate.ts` — reader/writer exclusion between engine runs and rule-pack
  tree mutations. A scan holds a read slot (`acquireRulesRead`, abortable) from
  resolving its packs until its record is stored; a mutation
  (`withRulesMutation`) blocks NEW reads at once, then waits for running ones to
  drain (`wait: true`, the install swap, bounded by `RULES_MUTATION_WAIT_MS`)
  or refuses with `OpengrepRulesBusyError` (`wait: false`, removal). Writer-
  preferring and serialized, so a scan arriving mid-swap waits a moment rather
  than reading half a pack, and the swap cannot starve. The routes' request-time
  `isAnyOpengrepScanRunning()` check stays as the fast path only — it could
  never cover an install whose swap lands minutes after its request, or scans
  started by the workflow hook / MCP.
- `scan.ts` — `runOpengrepScan()`: `opengrep scan --json --quiet --jobs N
  --timeout 30 --timeout-threshold 3 --max-target-bytes 1000000 --exclude …
  -f <pack> … -o <raw.json> <project>` with **cwd = the rules root** and packs
  as RELATIVE ids. That is load-bearing: Opengrep derives a finding's
  `check_id` from the config path relative to its cwd, and the FINGERPRINT
  hashes the check_id — running from anywhere else would make ids and
  fingerprints differ per machine. Gitignore is still honoured (verified: the
  engine finds the project root from the target). `targets` are resolved
  against the project and CONFINED to it (`resolveScanTargets` →
  `OpengrepBadTargetError` for `../…` / an absolute path elsewhere — the
  caller is scoped to one project and the stored record must be too). One
  scan per project (`OpengrepScanBusyError`; `isAnyOpengrepScanRunning` is
  what the pack routes consult; the rules read slot is what actually excludes
  a swap), `--jobs = max(1, cores-2)`, hard wall-clock
  timeout (kill), last 10 scans kept as `<id>.json` (engine output),
  `<id>.snapshot.json` (complete merged findings/coverage), `<id>.cache.json`
  (input identities/reusable paths) and `<id>.meta.json` (record). Metadata is
  atomically promoted last, so incomplete snapshots never enter history.
  Default `mode: full` always runs the engine; explicit `incremental` reuses
  compatible unchanged files and selects changed files with include filters
  against the original targets/cwd, preserving engine exclusion semantics.
  No changed inputs skips the engine. Missing/unsupported caches, engine/rule/
  context changes, or unrepresentable include patterns fall back to a full scan
  with `record.update.reason`; update metadata reports analyzed/reused coverage.
  Cancellable: a request `signal` or `abortOpengrepScan(project)` kills the
  engine, stores nothing, rejects with `OpengrepScanAbortedError` and frees
  the slot at once. A cancelled workflow run aborts through the request
  `signal` (`workflowRuns/stepTools.ts`); `abortOpengrepScan` has no
  production caller beyond its `index.ts` re-export; a `process` `exit`
  handler aborts every running scan so a backend restart never leaves an
  orphaned engine writing an unrecorded `-o` file.
  `startOpengrepScan` returns the scan id synchronously (the id is minted
  before the scan runs and is the stored record's id) plus the record promise;
  `runOpengrepScan` is that promise. `opengrepScanRunState(project, id)` says
  whether an id is still running or failed (the last 20 failures are kept in
  memory with their error) — what the poll route reads.
  Rules under `<project>/.opengrep/rules/` and `extraRulePaths` are passed as
  ABSOLUTE `-f` paths, so their check ids (and fingerprints) embed the local
  path — stable on one machine, not across machines; only the packs get the
  machine-stable relative ids. `scan.ts` keeps the single-flight, execution and
  error classes, and re-exports the two modules below so every `./scan.js`
  import keeps working. `runningOpengrepScan(project)` returns the current scan's
  id and start time for read-only reconnection through the project status payload.
  `cancelOpengrepScan(project, id)` aborts only a matching running id and waits
  for the engine to settle, so a stale chip cannot cancel a newer scan.
- `scanArgs.ts` — what a scan runs with: `resolveScanTargets` (+
  `OpengrepBadTargetError`), `defaultScanJobs` (`RESERVED_CORES`),
  `resolveRuleConfigs`, `buildScanArgs` (the `PER_FILE_*` / `MAX_TARGET_BYTES`
  engine limits), `defaultExcludeGlobs`.
- `scanRecords.ts` — the stored scans: `OpengrepScanRecord`,
  `listOpengrepScans` / `readOpengrepScan` / `latestOpengrepScan` and the
  prune to `MAX_SCANS_PER_PROJECT`, over one shared `readAllMetas(dir)`.
  Reads complete snapshots before legacy raw output; incremental records require
  their snapshot. Corrupt/missing cache metadata disables reuse without hiding
  saved findings. Pruning removes all sidecars.
- `scanCache.ts` — SHA-256 content identities for candidate regular files up to
  the engine's 1 MB limit, enabled rule contents, engine identity, scan scope,
  exclusions, ignore/config context and Opengrep environment. Never follows
  symlinks/reparse points. Path casing is preserved in CLI includes (comparison
  keys are case-insensitive on Windows). Reuse is validated for independent-file
  Opengrep 1.30.0 only; git index/ignore changes invalidate target selection.
  External git config/ignore includes, linked/parent git directories and linked rules
  conservatively disable it. Partial/error paths, skipped rules, global failures
  and files edited during analysis cannot be reused as clean. Retain zero-finding
  coverage only from engine `paths.scanned`; unvisited files stay unknown. Merge
  replaces changed findings and drops deleted/renamed paths. Severity/ignore
  presentation settings re-filter saved findings without invalidating analysis.
- `digest.ts` — pure. `parseOpengrepJson` (project-relative forward-slash
  paths, severity normalization, `PartialParsing` errors split out) →
  `buildDigest` (severity floor + `ignoreRuleIds` (full id or dot-suffix) +
  `ignoreFingerprints` (full or short) applied FIRST, dedup by fingerprint,
  group rule → file → occurrence, worst severity first then count) →
  `renderDigestMarkdown` (hard byte budget with per-group file/occurrence
  caps; a "Scan caveats" section for partially-parsed files and engine
  errors, rendered FIRST and reserved from the budget so it can never push the
  digest over). Groups render worst-severity-first; a group that does not fit
  whole is re-rendered TRIMMED (3 files × 2 occurrences + its own "… N more
  files" pointer) before being cut, so a single huge ERROR rule is never
  dropped while small INFO groups stay. The "Budget reached" tail names what
  was trimmed and what was left out, plus the drill-down hint. The
  **short fingerprint** (first 16 hex + `_N`) is what the digest prints and
  what the built-in template asks agents to put in tasks as `opengrep:<fp>`;
  every matcher accepts the full or short form, case-insensitively, with or
  without the `opengrep:` prefix. `digest.ts` itself holds the filter/build
  step and re-exports the two modules below, so callers import only it.
- `parseOutput.ts` — pure parse step: `parseOpengrepJson`, the finding/error
  types (including normalized `scannedPaths` for coverage), and the
  `shortFingerprint` / `fingerprintMatches` / `ruleMatches` matchers.
  Native `extra.is_ignored` suppressions remain in the raw inventory, with
  `nativeIgnored`; digests and graph colors exclude them.
- `graph.ts` — complete filtered per-file findings and highest severity,
  structured finding objects, counts/filter metadata and coverage caveats,
  independent of markdown caps. Visited files with no shown findings can be
  green; partial parsing, file errors, skipped rules and engine failures keep
  coverage uncertain. Unvisited files never appear clean.
  `allFindings` also preserves deduplicated findings below the severity floor
  and ignored/deferred findings for the viewer. Only open shown findings color
  the graph; changing presentation policy never destroys scan evidence.
- `renderDigest.ts` — pure markdown step: `renderDigestMarkdown` (header →
  budgeted sections → tail) with its budget knobs as named constants.
- `settings.ts` — `globalSettings.opengrep.packs` (per-pack enable, machine-
  global because packs are installed once per machine) and
  `userSettings.opengrep` (`extraRulePaths`, `excludeGlobs`, `severityFloor`
  default WARNING, `ignoreRuleIds`, `ignoreFingerprints`, `digestBudgetKb`
  default 60). Sanitized on READ; `effectiveOpengrepConfig` is the merge.
- `service.ts` — the facade: `getOpengrepStatus`, `scanProjectWithDigest`,
  `startProjectScanWithDigest` (the id at once + the digest result as `done`;
  its caller MUST observe `done`, or a failing scan is an unhandled rejection),
  `digestOfStoredScan` (with `rule` / `file` / `severity` / budget overrides
  for drill-down), `graphOfStoredScan` (read-only, exact stored scan id or latest).
  Graph reads hash current inputs to report current/changed/unknown freshness
  and per-file `stale`; legacy records remain readable with unknown freshness.
  Routes, MCP tools and the workflow pre-run hook call only
  this.

## Finding triage and agent review

- `triage.ts` — durable local dispositions and history in
  `~/.lattice/per-project/<hash>/opengrep-triage.json`. Writes are serialized
  and atomic; corrupt state is never replaced. Ignores require reasons;
  deferred risks require an owner and future review date. Expired exceptions
  read as open. Source suppressions and Settings ignores retain their distinct
  scope and cannot be overridden by a local reopen. These are presentation
  choices, never exclusions from scanner inputs or CI policy.
- `reviewStore.ts` — versioned `opengrep-reviews.json` in the same home project
  directory. Keeps running reviews and the latest 20 finished reports, including
  their findings and input identities. Validates agent output: exact finding
  IDs, evidence, confidence, action, and concrete changes/checks for fixes.
  Missing recommendations become `needs-review`. Recommendations become stale
  when rule/configuration identities, the finding file, or any declared context
  file changes; current input verification is required again when applying.
- `reviewSession.ts` — shared home-scratch spawn and cleanup, under
  `security-reviews/sreview_<ts>_<hex>/`. Persist ownership before spawn and
  install all harness completion/activity hooks. The brief permits source reads
  and writing the scratch report only; it prohibits project edits, executing
  project code, board writes and delegation. Codex additionally uses
  `--sandbox workspace-write` with the scratch as cwd; Claude/Pi follow the
  explicit review-only brief. Pi must POST completion after writing the report
  because its shutdown hook is only a backstop. Cancellation aborts pending
  spawn admission as well as reclaiming an existing PTY.
- `review.ts` — current-scan admission, review listing, cancellation and selected
  recommendation preview/application. Grouped fixes become ordinary Open tasks;
  shared suppressions become tasks to independently verify narrow, exact-rule
  `nosemgrep` comments and CI compatibility. Neither starts agents nor merges
  code automatically. Local ignores and deferred risks use `triage.ts`.
  Application is serialized and task markers make retries idempotent.
- `reviewRecovery.ts` — pre-listen presence recovery and a 30-second liveness
  watchdog. Callbacks read durable ownership directly after restarts. An
  unreachable terminal server is never proof of death; absent PTYs get 90 seconds
  for delayed report callbacks. A two-hour backstop settles stuck reviews.
  The shared boot sweep preserves running reports until the watchdog collects
  them, and delegates orphan deletion to guarded home-scratch cleanup.

## Consumers

- `routes/opengrep.ts` — `/api/opengrep/{status,install,rules/install,
  rules/:packId,scan,scans,scans/:id,scans/:id/cancel}`; 409 codes `busy` / `not-installed` /
  `no-rules` / `scan-cancelled` / `install-failed` / `installing` (DELETE of a
  pack mid-install). `POST /scan` with
  `async: true` waits at most `ASYNC_SCAN_ACCEPT_WINDOW_MS` (15 s): a scan done
  by then answers like the synchronous form, a longer one `202 {scanId,
  status: 'running'}`. The chip also sends `acceptImmediately: true`, returning
  the id without the 15 s wait so early cancellation can target it. `POST
  /scans/:id/cancel {project}` waits for that exact scan to stop; a stale id
  cannot cancel another scan. Aborted scan polls answer 409 `scan-cancelled`.
  `GET /scans/:id` answers a still-running id with 202 and
  a failed one with the status/code its POST would have had; after a backend
  restart the id is unknown (404 — the restart killed the engine). The
  synchronous form (the Settings button) remains a full scan; one scan per project
  either way. `GET /scans/:id?format=graph` returns the complete filtered
  findings/per-file snapshot and freshness for the Security graph overlay,
  with the same 202/failure polling semantics. Scan requests accept optional
  `mode: full | incremental` (default full).
- `latticeMcp/createServer.ts` — `opengrep_scan`, `opengrep_findings` (every
  session; both return the digest markdown, never raw JSON — `opengrep_scan`
  uses the async form and polls, because Node's fetch drops a response after
  300 s, well under the 10 min scan cap) and, **outside task worktrees only**,
  `opengrep_ignore` → `POST /api/opengrep/ignore` → `service.ts
  addOpengrepIgnores`: append rule ids / fingerprints to the project's ignore
  lists (a worktree agent's brief is untrusted input; letting it silence the
  findings its own change introduced would hide them from every later
  security-review digest). This is the ONE Lattice-settings write a planning
  agent may make —
  rule noise is a per-project setting, not a ticket for a human — additive
  and deduplicated, merged inside the settings file's own lock on a strict read
  (`userSettings` `updateUserSettings`) so neither a burst of calls nor a
  concurrent Settings save is clobbered; entries are removed in
  Settings → Tools. The Opengrep
  step prompt (`frontend/src/components/workflows/prompts/opengrep.md`) and
  the `{{tool_reports}}` block both point the agent at it.
- `workflowRuns/stepTools.ts` — the pre-run hook for an agent step whose
  `tools` includes `opengrep`: scan → `OPENGREP_FINDINGS.md` beside
  `WORKFLOW_STEP.md` → the `{{tool_reports}}` token in the brief. A missing
  engine / no rules / busy / failed scan does NOT fail the step: the token
  becomes a one-paragraph explanation and the step runs.
- Settings → Tools tab (`frontend/src/components/settings/ToolsTab.tsx`).
- Graph Security chip (`frontend/src/components/forceGraph/hooks/useSecurityOverlay.ts`):
  first activation without saved results runs a full scan; refresh reconnects through `status.project.runningScan`
  and GET polling of that exact id. Shows a spinner and an ETA from the previous
  scan's duration. Restores saved snapshots; idle chip toggles the view without
  rescanning. Hover previews and file/total-findings clicks open the searchable
  findings panel. Separate Update changed files / Full scan actions POST;
  background focus/git-change/30 s reads only check freshness. Keeps the normal
  graph or previous results visible until completion. Clicking while scanning cancels the exact id (including
  a restored scan), with "Cancelling…" until the backend confirms. Cancellation
  intent before acceptance is honored once the id arrives; cancellation preserves
  the previous snapshot. Project changes
  and unmount abort HTTP waiting; an accepted backend scan may finish normally.

## Tests

`opengrepDigest` (fixture = a trimmed real scan of Lattice), `opengrepScan`
(fake engine at the spawn seam: cwd, args, storage, busy, error classes),
`opengrepInstall` (fake fetch + pin table: size → digest → runs, quarantine
message, `.part` cleanup + sweep, single-flight across a pending asset choice),
`opengrepPackConcurrency` (fake git fetch + blocking fake engine: removal
mid-install stays removed, DELETE mid-install is 409, a swap waits for a
running scan and a scan waits for a pending swap, removal refused mid-scan),
`latticeMcpOpengrep` (202 + poll, headers timeout → "still running"),
`opengrepRulesPrune` (the licence boundary on a fixture tree),
`opengrepPlatformSettings` (asset table, pin presence, settings sanitizing),
`opengrepNoVendoredAssets` (no binary / pack in `git ls-files`).
`opengrepCache` covers changed/clean/deleted/renamed files, rule invalidation,
mid-scan edits and cancellation; `opengrepRealCache` optionally validates include
selection (including mixed-case Windows paths) against an installed engine in
an isolated project/HOME. Set `LATTICE_TEST_OPENGREP_BINARY` to opt in; Windows
also needs `LATTICE_TEST_OPENGREP_USERPROFILE` for the engine child only.
