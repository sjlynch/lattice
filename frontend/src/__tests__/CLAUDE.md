# frontend/src/__tests__

Frontend tests use Node's built-in `node:test` runner with `tsx` — mostly pure
TS / React-state tests, not a browser or Vite integration suite. `npm test`
from `frontend/` runs `node --import tsx --test src/__tests__/*.test.ts` (one
level only; there is no HOME-isolation preload — no frontend test writes to
disk). Run one file from `frontend/` with
`node --import tsx --test src/__tests__/<name>.test.ts`. Type-check: `npx tsc -b`.

## Conventions

- Import assertions from `node:assert/strict` and test APIs from `node:test`.
- No DOM under `node --test`: install globals through `domDoubles.ts`
  (`installGlobal`, `installWindow`/`withWindow`, `installCanvasDocument`,
  `stubClipboard`, `installManualTimers`, `FakeWebSocket`/`installFakeWebSocket`)
  and restore them in `t.after`/`finally`, so co-resident suites don't bleed
  global state. Don't hand-roll a second copy of a double that lives there.
- Prefer extracted pure helpers / hook adapters over mounting large UI trees.
  When rendering is needed, follow the nearby `react-test-renderer` + `act`
  pattern (`IS_REACT_ACT_ENVIRONMENT` set via `installGlobal`).
- Never depend on the Vite dev server or a real backend: stub `fetch` and WS at
  the API boundary; hold HTTP responses deferred and drive timers manually
  when the test is about ordering.
- Memory-ownership tests assert deterministic release/disposal with controlled
  doubles and disposal/reference instrumentation — never real GPU bytes or
  forced-GC timing. They prove a release contract, not the absence of a leak.
- Keep tests as flat `.test.ts` files here; shared code is `domDoubles.ts` and
  `queueScheduler.fixture.ts` (builders + scenario harness for the split
  `queueScheduler.*` suites).
- Most files' header comment carries their regression story — read it before
  weakening an assertion.

## Finding a test

Tests import the module under test by relative path, so grep its file name
here: `rg -l "useMergeRunSync" frontend/src/__tests__` finds both the
module-named suite and behaviour-named regressions
(`mergeConflictKeepsFreshResolver`, `liveSnapshotOrdering`). Split suites use
dotted suffixes (`queueScheduler.step.test.ts`). Name patterns worth knowing:

- `*ProjectSwitch*`, `*ProjectScope*`, `*FolderSwitch*`, `*ProjectPin*` — project
  fences (a late result or by-id call must not land on another project).
- `*LateFetch*`, `*StaleLoad*`, `*Lifetime*` — late-response / unmount races.
- `*StartGuard*` — double-click / duplicate-session guards.

## Cross-cutting guards (hard to find by name)

- `sidebarPaneHiddenCss` — reads `styles/sidebar.css`: `.sidebar-pane.hidden`
  must move hidden panes out of the clipped box with a transform
  (visibility-only keeps xterm rendering; `display: none` breaks its fit).
- `securityOverlay` — Security never POSTs a scan from an effect, a project
  change or a graph update (scans only on an explicit click).
- `backendRestartResilience` — the start/resume retry policy: replay only
  failures the backend never acted on (task Resume, workflow start/resume,
  queue stop on an uncertain acknowledgement), plus `retryTransient` itself.
- `liveSnapshotOrdering` — a live WS event beats a late initial GET (merge
  runs, post-merge hooks, the task list).
- `taskByIdProjectPin` / `workflowByIdProjectPin` — by-id API calls send the
  ACTIVE board's project as `?project=`.
- `fetchTasksWholeBoard` — the board's `fetchTasks` opts out of every
  agent-tuned `GET /api/tasks` default.
- `terminalProjectScope` / `terminalActivePolicy` — backend-stamped paths
  compare through `normalizeDirPath` / `sameProjectPath`, never `===`.
- `escapeInnermost` / `focusTrapStack` — one Escape closes, and one focus trap
  handles Tab for, only the innermost open layer.
