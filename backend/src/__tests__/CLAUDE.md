# backend/src/__tests__

Backend tests use Node's built-in `node:test` runner with `tsx` (`npm test`
from `backend/`, which collects `src/__tests__/*.test.ts` — one level only).
The `test` script `--import`s `helpers/isolateHome.mjs` first: it points
`HOME`/`USERPROFILE` at a throwaway temp dir so the suite never writes into the
real `~/.lattice` (task DBs, `projects.json`, snapshots). It must load before
any test imports the task cache, whose home path binds once at module load. It
also sets `LATTICE_TEST_HOME_ISOLATED`; a test that writes under `~/.lattice`
(`opengrepScan`, `opengrepInstall`) throws at import without that marker, so a
bare `node --test <file>` can't land fixtures in your real home. Run one file
with `node --import tsx --import ./src/__tests__/helpers/isolateHome.mjs --test <file>`.

## Conventions

- Import assertions from `node:assert/strict` and test APIs from `node:test`.
- Prefer focused pure-unit coverage; for filesystem tests use temp dirs from
  `helpers/tempDir.ts` and clean them in `t.after`/`finally`.
- Every file runs in one Node process against source: no global mutable state
  leaks, no real dev-server dependencies, no long-lived timers. Don't call code
  that patches the global console or registers process handlers (e.g.
  `installCrashLogging()`) — test the pieces it composes.
- Test route handlers by building the router/app in-process, never by starting
  the backend server.
- HOME is isolated, so `~/.gitconfig` is invisible: a temp repo that commits
  passes its identity with `-c user.name=… -c user.email=…` (or a local config
  on that temp repo).
- Keep tests as flat `.test.ts` files here; shared code goes in `helpers/`.
- Each file's header comment carries its regression story — read it before
  weakening an assertion.

## Finding a test

Tests are named after the module they cover (`crashLog.test.ts`), with dotted
suffixes for a sub-area (`worktree.merge.branchState.test.ts`,
`health.analyze.test.ts`) — grep the module name in this directory. Tests for
the dev runner scripts (`backend/scripts/dev/`, root `scripts/`) live here too,
importing them by relative path.

- `helpers/isolateHome.mjs` — the HOME-isolation preload above.
- `helpers/tempDir.ts` — `withTempDir` / `writeLayout` filesystem fixtures.
- `helpers/health.ts` — shared `HealthMetrics` fixtures for the split `health.*` suites.
- `helpers/hangAnalyzeFixture.mjs` — plain-JS analyzer the real health worker
  loads to hang on its own thread (worker-timeout tests).
- `fixtures/opengrep-scan.json` — recorded engine output for the Opengrep digest/scan tests.

## Cross-cutting guards (hard to find by name)

- `opengrepNoVendoredAssets` — no Opengrep binary, signature or third-party rule file may be tracked (the MIT licence boundary).
- `projectGit`, `cleanupSafety`, `pruneReparsePoints` — `.git`-deletion defences: the git subcommand whitelist, worktree-path / reparse-point throw-guards.
- `repoIntegrity` — the merge-run circuit breaker (defence #6): fires on a vanished `.git` or non-forward HEAD, never on a fast-forward.
- `gitIdentityUntouched` — no shipped source writes the host's git identity; every commit-instructing brief keeps the per-commit `-c` recovery.
- `latticeApiDocsDrift` — the API doc templates and the root `CLAUDE.md` HTTP table vs the live router; a new route fails until documented or added to `UNDOCUMENTED_ROUTES`.
- `latticeApiDocs` — the generated `LATTICE_API.md` index (read whole on every Lattice question) must stay under 5 KB, even for a long project path.
- `defaultPromptMigrations` — backend built-in step prompts must match the frontend `prompts/*.md` bytes.
