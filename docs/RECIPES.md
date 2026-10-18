# Change recipes

On-demand playbook (not auto-loaded): for the most common change types, the ordered touch points, the guard that pins each, and the gotchas that actually bit. Folder `CLAUDE.md` files remain the source of truth for rules — each recipe names its owner; read it before editing.

**BE** paths are under `backend/src/`, **FE** under `frontend/src/`. One test file: `npm run test:file -- <path>` from the repo root. Type-check: `cd backend && npx tsc --noEmit`, `cd frontend && npx tsc -b`.

## 1. Per-project user setting

When: a preference stored in `<project>/.lattice/userSettings.json` (`PATCH /api/settings`). Owners: BE `userSettings/CLAUDE.md`, FE `components/settings/CLAUDE.md`.

1. BE `userSettings/types.ts` — field on `UserSettings`, commented with what *absent* means. Node-free (type-only imports from node-free modules); the FE uses this very type.
2. BE `userSettings/features.ts` — accessor encoding the default (`isXEnabled`, plus pure `xIn(settings)` when callers hold settings); re-export from the `userSettings.ts` facade. Consumers call it, never re-derive the default.
3. BE `userSettings/storage.ts` — shape-sensitive fields: add to `STRING_FIELDS` / `STRING_ARRAY_FIELDS` (or a branch in `normalizeUserSettings`) and `userSettingsShapeError` (PATCH → 400). Verification opt-ins `taskAgentTypecheck` / `taskAgentTests` use `VERIFICATION_FIELDS`: boolean-only PATCH, malformed stored values become absent. Pin in `__tests__/userSettingsFieldShapes.test.ts`.
4. Route and FE type: nothing — `routes/settings/userSettings.ts` merges the whole body; `api/types/settings.ts` re-exports `UserSettings` via `shared/wireTypes.ts`.
5. FE UI. Terminals-tab checkbox = a fetched toggle: key + default + read in `components/settings/fetchedToggles.ts`; value/setter on `SettingsDrafts` (`useSettingsDrafts.ts`); the `SaveDrafts` field + `fetchedToggles` map in `saveSettings.ts`; a row in `terminalToggleSections.tsx`. Other tabs: the tab's `get<Thing>Patch()` + one line in `saveSettings.ts`, and include the getter in `useSettingsDirty.ts`.
6. FE readers outside the dialog take their slice from App's `hooks/useUserSettings.ts`, not a second fetch.

Gotchas: a patch stays `undefined` until loaded or touched — an unloaded default written by an unrelated Save resets the saved value (`saveSettingsUnloaded`, `settingsDraftLateFetch` tests). An editor saving a whole sub-object loads with `fetchUserSettingsStrict`. An accessor nobody reads fails `deadExports`.

Agent prompts' `taskWritingRules` and `plannerSpecGaps` follow this pattern in `useTaskWritingDraft.ts`: per-field touched patches, consumed by `workflowRuns/stepSpawner.ts` for the workflow-step template's `{{task_writing_guidance}}` token. The recent-gap preview reads `/api/spec-gaps` only when expanded.

Agent prompts' default-off `taskAgentTypecheck` / `taskAgentTests` use `InstructionTemplatesTab.tsx`'s `useTaskAgentVerificationDraft`: only flips produce patches. BE `taskVerification.ts` renders `{ typecheck, tests }` in task and merge briefs plus spawn system prompts; keep both channels covered in `taskVerification.test.ts`.

## 2. Machine-global setting

When: a fact about the machine (`~/.lattice/globalSettings.json`, `PATCH /api/global-settings`). Owner: BE `globalSettings/CLAUDE.md`.

1. BE `globalSettings.ts` — field on `GlobalSettings` (absent ⇒ ?), validated in `sanitize()`; a non-trivial validator lives beside its shape (e.g. `opengrep/settings.ts`).
2. BE `routes/globalSettings.ts` — forward the field explicitly in the PATCH (400 on a bad type) and apply any live effect there (like `setSpawnQueueSoftCap`). Unlike `/api/settings`, an unforwarded field is silently dropped — that once lost every MCP/Pi save.
3. Add the row to the field table in `globalSettings/CLAUDE.md`.
4. FE `api/globalSettings.ts` — its `GlobalSettings` is a hand mirror (the backend type sits in a `node:fs` module, so it can't ride `wireTypes.ts`). UI: a `scope: 'global'` tab (`AgentsTab.tsx`, `PiTab.tsx`, `ToolsTab.tsx`) + `saveGlobalSettings` in `saveSettings.ts`.
5. Test: `__tests__/settingsPersistence.test.ts` (partial patches keep other fields) + the validator's suite.

Gotchas: a write derived from the current value uses `updateGlobalSettingsWith(fn)` (reads inside the lock); a destructive derived write reads with `readGlobalSettingsStrict()`. Per-project policy is recipe 1, not this.

## 3. HTTP route

Owner: BE `routes/CLAUDE.md` ("Adding a route", "The `project` parameter").

1. Handler in the domain's router module (or a new `buildXRouter()` factory); logic stays in the domain module. Register the absolute `/api/...` path — routers mount prefix-less (the drift test asserts it).
2. Project input: `readProjectParam` (`routes/projectParam.ts`; task routes use `routes/tasks/requestUtils.ts`). A route that writes under the project also calls `requireExistingProjectDir`; a by-id route honours `?project=` via `requireOwnedByRequestedProject`. Add a call to `__tests__/relativeProjectRefused.test.ts`.
3. Mount in `mountRouteFactories` (`server/app.ts`) where no `:param` route shadows a static path; restartDrain stays first.
4. A row in `routes/ROUTES.md`, plus either an endpoint-table row in `latticeApiDocs/LATTICE_API_RECIPES.template.md` (the index `LATTICE_API.template.md` stays < 5 KB — `latticeApiDocs.test.ts`) or an `UNDOCUMENTED_ROUTES` entry with a reason. `__tests__/latticeApiDocsDrift.test.ts` fails in both directions.
5. FE binding in the domain file under `api/` (`asJson` / `postJson` / `patchJson` / `deleteJson` from `api/http.ts`), types per recipe 5; by-id calls pin the active project (`taskByIdUrl` / `withProjectParam`).
6. Test the router in-process; never start the backend.

Gotchas: a route a Stop hook POSTs must end in a `CALLBACK_PATH_RE` suffix (`callbackOutbox/drain.ts`) or a callback lost in a restart is never replayed. A route that starts an agent / merge run joins `REFUSED_WHILE_DRAINING` (`routes/restartDrain.ts`). Validate the project before resolving its identity (resolving a relative value first registers a phantom project).

## 4. WebSocket endpoint or event

Owners: BE `ws/CLAUDE.md`, `ws/endpoints/CLAUDE.md`; FE `api/CLAUDE.md`.

New endpoint:
1. Event source: `createEmitter<[Event]>('label')` (`emitter.ts`) behind `subscribeX` / `notifyX` in the domain module (pattern: `taskSpawnEvents.ts`); events carry `projectPath`.
2. Builder in `ws/endpoints/` via `buildProjectWss` (`initial`, `subscribe`, `projectFromEvent`, `isSnapshotEvent`, `payloadFromEvent`) or `buildProjectSnapshotWss` (`ws/projectEndpoint.ts`). Machine-global → a raw `noServer` WSS like `ws/endpoints/harnesses.ts`.
3. Route tuple in `buildWebSocketRoutes` (`ws/wsServer.ts`) — never a `{server, path}` WSS.
4. A `WS` row in `routes/ROUTES.md` (not drift-tested; it's on you).
5. FE: `subscribeWs`, or `subscribeWsShared` when several features watch one path (identical replay policy from every caller), in the domain's `api/` file; message union in its `api/types/` file (WS envelopes are declared FE-side).

New event on an existing endpoint (e.g. `/ws/tasks`): add the variant to the endpoint's event union, subscribe/unsubscribe it in `subscribe`, map it in `payloadFromEvent`, keep `isSnapshotEvent` false (transients are buffered through the handshake), then extend the FE union + dispatcher (`subscribeTasks`, `api/tasks.ts`).

Gotchas: `subscribe` runs per connection — every connection must get the SAME wrapper object (memoize on the source: `sharedWrapper` in `ws/endpoints/tasks.ts`), or serialize-once misses and each tab re-stringifies. Never raise `/ws/tasks` snapshot frequency (each frame is the whole board); high-rate signals get their own transient type. `projectFromEvent` returns a `canonicalProjectPath`.

## 5. Wire type both packages use

Owners: BE `shared/CLAUDE.md`, FE `api/types/CLAUDE.md`.

1. Declare it in a node-free BE module (usually the domain's `types.ts`). If its home reaches node/npm, move the TYPE there and re-export it from the old module — never move runtime code for this. A route's inferred literal gets a named type + an explicit return type.
2. `export type { … } from` in `shared/wireTypes.ts` — type-only, nothing else.
3. FE: re-export it from `shared/wireTypes.ts` (relative path) in the domain's `api/types/` file (a new file also goes in `api/types/index.ts`); delete any hand mirror.
4. Guards: `__tests__/sharedFolderBoundary.test.ts` (everything reachable from `shared/`, inline `import('…')` types included, imports relative paths only) and `npx tsc -b` (`verbatimModuleSyntax`, `erasableSyntaxOnly`: `import type`, no enums / parameter properties).

Gotchas: runtime values can't ride `wireTypes.ts` — shared logic goes in a `shared/` module (if the executor reaches it, recipe 9), otherwise keep the constant equal by hand. Remaining hand mirrors are listed in `api/types/CLAUDE.md`; check the backend when touching one.

## 6. Built-in workflow step prompt

Owners: FE `components/workflows/prompts/CLAUDE.md`, BE `workflows/CLAUDE.md`.

New quick-add chip: body `components/workflows/prompts/<id>.md` (planner-only: it files tasks, never edits or commits — the step brief forbids both); `?raw` import + entry in `DEFAULT_PROMPTS` (`components/workflows/defaultPrompts.ts`, optional `tools`); for stack tailoring, add its id to `ProjectAwarePromptId` / `PROJECT_AWARE_PROMPTS` (`promptTemplates.ts`).

Rewording one:
1. Edit the `.md`.
2. BE `workflows/defaultPromptMigrations.ts`: in its `quick-add:<file>` entry prepend the old body to `legacy` (newest first, byte-exact from git history) and set `current`. Not every chip has an entry — add one when saved workflows should get the new wording (the guard then pins it).
3. Template steps in `workflowTemplates.ts` mirror the `template-step:*` entries by hand — no drift test covers them.
4. A reworded tailoring bullet (`projectStackDetection.ts`) → `DEFAULT_PROMPT_LINE_MIGRATIONS` (`defaultPromptLineMigrations.test.ts`).

Guard: `__tests__/defaultPromptMigrations.test.ts` — `current` equals the `.md` (CRLF-normalized, trailing whitespace trimmed), no `current` asks for a commit, no legacy equals current. Migration is a prefix match, so a hand-edited saved prompt is never touched.

## 7. Tool on Lattice's own MCP server

Owners: BE `latticeMcp/CLAUDE.md`, `mcp/CLAUDE.md`.

1. Register it in its tier under `latticeMcp/tools/`: `readTools.ts`, `writeTools.ts` (every session), `boardManagementTools.ts`, `opengrepTools.ts`; controller-only: `workflowTools.ts`, `controllerTools.ts`. Register through `host.tool(name, config, async (client, args) => …)` (`toolHost.ts`) so the same code serves the pinned server and the controller; body: `toToolResult(await client.call('/api/…', { method, body, query }))`; the route must exist (recipe 3). A shared-tier tool reaches the controller only if it is in `CONTROLLER_BOARD_TOOLS` (`createControllerServer.ts`).
2. Scope: `createServer.ts` returns before board management when `taskId` is set (task worktrees). A tool that re-lanes, deletes, spawns or permanently suppresses goes after that cut. Registration order is what the model sees.
3. Update `EXPECTED_TOOLS` / `WORKTREE_TOOLS` / `CONTROLLER_TOOLS` (grep `__tests__/latticeMcp*`), the counts in `latticeMcp/CLAUDE.md`, and the tool names in the `mcp/catalog.ts` entry description and `LATTICE_API.template.md`.

Gotchas: no pinned tool takes `project` (the client pins it; the test asserts it; the controller adds `instance` + `project` itself) or re-implements an API default; a description of ≤ 40 chars fails. Import nothing beyond `latticeMcp/` (own process, run from `dist/`, so only newly spawned sessions see a change); nothing may print to stdout. Writes replay only after `ECONNREFUSED` / 503.

## 8. Graph overlay or extension style

Owners: FE `components/forceGraph/CLAUDE.md`, `components/forceGraph/hooks/CLAUDE.md`.

Extension style: one `EXT_STYLES` entry in `extensionStyles.ts` (shape rules in its header); graph and Legend follow. An extension the scanner skips also goes in `SOURCE_EXTS` (BE `health/constants.ts`; scanner, ripgrep, health watcher and ghost history read it). AST metrics: BE `health/CLAUDE.md` → "Adding a language".

Hold-key recolor overlay (pattern: `D`):
1. Sprite module like `components/forceGraph/deadCodeOverlay.ts`, styles through the shared `materialFor` cache.
2. Hook beside `hooks/useDeadCodeOverlay.ts`: `useHoldKeyMode(momentaryLetterMode(…))`, mode `held || pinned`, `clearLabelsAndRefresh` on toggle.
3. Compose in `hooks/useGraphOverlays.ts` (fold into `metricOverlayActive` for a metric view); pin key in `hooks/useOverlayPins.ts`, chip in `GraphOverlayKey.tsx`, hint in `GraphHud.tsx`.
4. Precedence in `spriteDecision.ts` (`SpriteBaseKind`; `spriteDecision.test.ts`) and its case in `nodeObjectFactory.ts`.

Gotchas: filter with `nodeVisibility` / `linkVisibility` (`useGraphFilter`), never add/remove nodes. Hold an idle reason only while animating; a one-shot change calls `wakeForRefresh()`. GPU caches are key-bounded and freed only by `disposeSharedGraphResources` (`spriteMaterialCache.ts`); textures go through `finishCanvasTexture` (`canvasTexture.ts`); gauges in `graphMemGauges.ts`. Nothing scans Opengrep without an explicit click.

## 9. File the terminal-server imports

Owner: BE `terminalServer/CLAUDE.md`.

1. Add its compiled `.js` name to `FINGERPRINT_FILES` (`terminalFingerprint.ts`): every runtime module in `terminal-server.ts`'s static import graph, `shared/` ones included (type-only imports don't count).
2. Never import `latticeApiDocs.ts` (use `latticeApiDocs/docPath.ts`) or `memDiag/browser.ts`.

Guard: `__tests__/terminalFingerprint.test.ts`. Gotchas: a byte change to any fingerprinted file makes the live executor stale; it is swapped only when idle (navbar chip, `terminalServerStatus.ts`) and live ptys are never killed for it. So keep policy in the backend and ship it as data in the `POST /sessions` body (`resolveHarnessSpawnBody` in `terminalServerClient/spawnBody.ts`, applied by `terminalServer/createSessionHandler.ts`); a new wire field must tolerate an older executor (version + capability flags in `terminalProtocol.ts`).

## 10. Long-lived collection or listener set

Owner: BE `memDiag/CLAUDE.md`.

- Listeners: `createEmitter(label)` (`emitter.ts`), never a hand-rolled `Set` — it snapshots on emit, isolates a throwing listener and reports `listeners.<label>` (`emitter.test.ts`).
- Maps / caches / registries: `registerMemGauge('area.thing', () => things.size)` at module scope beside it (`memDiag.ts`; executor or leaf code imports `memDiag/gauges.ts`). O(1) readers; byte values get a `mem.` name segment.
- Per-project cached stores: extend `ProjectStateManager` (`projectStateManager.ts`) — `state.<name>.*` gauges come free.
- FE: `registerMemGauge` (`debug/memDiag.ts`) returns an unregister — call it at teardown for per-instance resources.

Gotcha: key per-project collections by `canonicalProjectPath`; a second spelling duplicates the entry (and, in `gitWatcherRegistry.ts`, a recursive watcher set).

## 11. Add or move a module

Owners: `backend/src/CLAUDE.md`, `frontend/src/CLAUDE.md`.

- BE domain surface = a root facade beside its folder (`worktree.ts` over `worktree/`), never `<x>/index.ts` (`moduleLayout.test.ts`). A folder without one is fine (import `scanner/scan.ts` directly). Specifiers end in `.js`.
- No new runtime cycle (`importCycles.test.ts`: break it with a leaf module or `import()`, don't list it); no unreferenced export (`deadExports.test.ts`: delete, don't allowlist).
- A move updates every hard-coded path: docs (`docPaths.test.ts` checks backticked paths in every `CLAUDE.md`), `FINGERPRINT_FILES`, `ALLOWED` in `rawGitAllowlist.test.ts`, `KNOWN_CYCLES` in `importCycles.test.ts`, `scripts/copy-assets.mjs` (non-TS runtime assets). Keep compatibility barrels tests import (`routes/tasks/crudHandlers.ts`, `routes/tasks/queuedSpawn.ts`).
- New folder doc: `CLAUDE.md` (≤ 12 KB, `docBudget.test.ts`) + a one-line `AGENTS.md` pointer, listed in the parent map.
- FE: big launchers keep a top-level shim (`components/TaskBoard.tsx` → `taskboard/`); `api/` is imported through `api/index.ts`.

## 12. Add a test

Owners: `backend/src/__tests__/CLAUDE.md`, `frontend/src/__tests__/CLAUDE.md`, `e2e/CLAUDE.md`.

- Flat `__tests__/<module>.test.ts` in the package, named after the module (dotted suffix for a sub-area: `worktree.merge.branchState.test.ts`). Runners glob one level only — a test in a subfolder never runs; helpers go in BE `__tests__/helpers/` or FE `domDoubles.ts`.
- Run: `npm run test:file -- <path>` from the repo root; a whole package with `npm test` in `backend/` or `frontend/`.
- BE: `node:test` + `node:assert/strict`. HOME is a temp dir via the `helpers/isolateHome.mjs` preload (a bare `node --test` skips it). Temp repos commit with `-c user.name=… -c user.email=…`. Routes built in-process; no `installCrashLogging()`, no long-lived timers.
- FE: no DOM — install doubles from `domDoubles.ts` and restore them; complete fixtures typed with real wire types; `npx tsc -b` type-checks tests (`tsconfig.test.json`).
- The header comment carries the regression story. E2E: Playwright `e2e/*.spec.ts`, `npm run test:e2e` (isolated ports + HOME).

## 13. Persisted JSON store / home-scoped file

Owners: `backend/src/PROJECT_IDENTITY.md`, BE `projectState/CLAUDE.md`.

- Path from `projectPath.ts` (`homeProjectDir(project)`, `latticeHomeDir()`) — never recompute a hash or derive a second dir from a new path spelling.
- Write with `atomicWriteFile` (`fsAtomic.ts`); read-modify-write under `runExclusive(key, fn)` (`serializeWrites.ts`).
- Only `ENOENT` means empty; an unreadable or corrupt file is preserved, never replaced by defaults. Secrets: `persistedSecretFile.ts`.
- State of a run that must survive a restart: mirror it and re-adopt at boot (BE `recovery/CLAUDE.md`).

## Covered by the owning doc

- Agent brief template / `{{token}}`: BE `instructionTemplates/CLAUDE.md` → "Adding / changing a template".
- Harness system prompt / Lattice preamble: BE `harnessSystemPrompts/CLAUDE.md`.
- Health smell or score component: BE `health/CLAUDE.md`.
- Third-party MCP catalog server: BE `mcp/CLAUDE.md` (never `defaultEnabled`).
- FE endpoint binding: FE `api/CLAUDE.md` → "Adding an endpoint".
