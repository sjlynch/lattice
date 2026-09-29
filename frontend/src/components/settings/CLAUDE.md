# frontend/src/components/settings

Tab panels for the Settings dialog. The parent, `SettingsDialog.tsx`, lives one
level up in `components/`: a **`FloatingPanel`** (draggable/resizable/
maximizable, no backdrop so the app stays interactive; titlebar `×`/maximize;
geometry persisted under `lattice.settings.window`) with a tab strip (Terminals /
Agent prompts / Metrics / Agents / Pi / MCP / Tools) that renders every tab and a
single Save/Cancel footer. The dialog itself is now essentially just that chrome plus
body rendering — all the save/dirty/close machinery lives in
`useSettingsController.ts` (below).

Lengthy explanatory copy lives behind `SettingsInfo` — a small `(i)` button next
to a section title that toggles a popover (`.settings-section-title-row` lays the
two out inline). `SettingsSection.tsx` provides the shared presentational section
chrome (and a checkbox wrapper) for that title row; keep it structural-only so
callers own behavior. `SettingsInfo` closes on outside-click and on Escape; its
Escape handler is **capture-phase + `stopPropagation`** so it dismisses just the
popover without the FloatingPanel's own Escape closing the whole dialog. Keep section
titles + control labels always-visible and push the detail into the popover.

## Shared tab pattern

Each tab is a `forwardRef` panel that:
- (re)loads its saved value + overrides when the dialog `open`s, into local
  **draft** state — editing never mutates anything persisted until Save;
- exposes an imperative handle `get<Thing>Patch()` returning the value to
  persist, or **`undefined`** when the user hasn't touched it (or the load
  hasn't finished). That `undefined` is the clobber-guard: it stops an
  unrelated Save from rewriting a value this tab never actually edited;
- renders `null` while `!active` (hooks still run before the early return, so
  the handle stays live even for a tab the user never opened).

`useSettingsController.ts` owns the per-tab imperative `ref` handles and runs
the save (delegating to `saveSettings.ts`). Each project/open transition creates
a new session token, invalidated in layout-effect cleanup on replacement or
unmount. Accepted saves finish persisting their captured project/global data,
but parent callbacks, close, and saving/error settlement apply only while their
session is active. A new session resets saving/error immediately; path equality
alone cannot protect an A → B → A switch or close/reopen. Pinned by
`__tests__/settingsSaveLifetime.test.ts` (rendered controller + App-like slices,
deferred project/global saves, success/failure and overlapping sessions).
Focused helpers keep the rest small:
`settingsTabs.ts` is the tab metadata + `Tab` union, `useSettingsDirty.ts`
derives the per-tab **dirty** map (`dirtyByTab` + a `bumpDirty` tick that
re-reads the non-reactive patch getters after each body edit), and
`useSettingsCloseFlow.ts` gates the warn-on-unsaved-close flow (`requestClose`
→ `confirmUnsaved`). The dialog spreads the returned `refs` onto each tab and
renders `saving` / `error` / `dirtyByTab`.

`saveSettings.ts` is the orchestrator. The controller hands it every tab's
handle (any may be `null` if unmounted), it reads each `*Patch()`, merges the
*defined* ones into one `PATCH /api/settings` body, then applies project Claude
instrumentation and the machine-global half (`saveGlobalSettings`: max-agents,
Pi providers + model menu, Opengrep pack enables), and finally fires the parent
callbacks. With NO project open the controller calls `saveGlobalSettings` alone
— the global tabs are editable without a folder, and a silent early return used
to leave the dialog stuck on "Save" (the unsaved-changes prompt's Save did
nothing). The navbar Settings button is enabled with no project; the dialog
then shows only the `scope: 'global'` tabs (Agents / Pi / Tools —
`visibleSettingsTabs` / `resolveSettingsTab` in `settingsTabs.ts`, so the default
`terminals` selection falls through to Agents) plus an "Open a project to edit
project settings" scope note. MCP is hidden too (its enables are per-project).
The hidden per-project tabs stay mounted but inactive; each skips its load on an
empty folder (`useSettingsDrafts`, `useOverrideDraft`, `HarnessSystemPromptsTab`,
Tools' scan-filter half), so their patches stay `undefined` and nothing reads
dirty. Pinned by `__tests__/settingsTabsNoProject.test.ts`. `useSettingsDrafts.ts` owns the handful of drafts that live on the
parent itself rather than a tab — the terminal-default harness +
skip-permissions, the Codex `--yolo` toggle (default ON — part of
`terminalLaunchSettings`, so it's reseeded synchronously with the harness/skip
drafts and feeds the sidebar's new-Codex-terminal command as well as being read
by the backend for every Codex spawn), the instrument-Claude /
disable-memory / qa-auto-close toggles, and the three terminal-tab restore
drafts (`restoreTerminalsOnOpen` — `always` / `ask` / `never` —,
`restoreNudgeAgents`, `restoreNudgeUserTabs`; see the terminal-registry notes
in the root `CLAUDE.md`). The terminal-default drafts and `startupTerminals`
are seeded from App's shared `userSettings`, so they ride the per-project
`PATCH` only once it has loaded (`settingsLoaded`, threaded App → TopAppBar →
SettingsDialog → controller) or when the user edited them
(`getTerminalLaunchTouched()` per field → `pickSavableTerminalLaunch`; the
Startup tab handle's `isTouched()`). Before the load their seed is `[]` / App's
defaults (App resets `terminalLaunchSettings` while unloaded rather than keeping
the previous project's), and an unrelated save used to wipe the project's
startup commands — pinned by `__tests__/saveSettingsUnloaded.test.ts`. The
fetched toggles (instrument /
memory / qa-auto-close / the three restore drafts) ride it only via
`getSavableFetchedToggles()` (`pickSavableFetchedToggles`): all of them once this
open's GET (`fetchUserSettingsStrict`) succeeded, otherwise only the ones the
user edited — an unloaded, untouched draft still holds its default and would
reset the saved value. Its async settings load updates fetched
baselines but seeds only untouched toggle drafts, so a late GET never overwrites
edits made while the dialog was opening. Those seven fetched toggles are
data-driven from `fetchedToggles.ts`: the `FetchedToggles` shape,
`FETCHED_TOGGLE_DEFAULTS` (the absent-setting defaults, in save-payload order),
`readFetchedToggles(userSettings)`, `normalizeRestoreMode`, `noneTouched()` and
`pickSavableFetchedToggles` (both re-exported from `useSettingsDrafts.ts`). The
hook holds them as one values object + one loaded baseline + one touched ref,
behind a generic `setFetched(key, value)`, while `SettingsDrafts` stays flat
(`setInstrumentClaude` etc. are stable wrappers). Adding a toggle = a key +
default + read in `fetchedToggles.ts`, plus its value/setter pair on
`SettingsDrafts`. `TerminalSettingsSections.tsx` renders
those sections (the project-settings block atop the Terminals tab); it's a plain
`drafts`-driven component with no ref handle, since the controller persists
those drafts — `SettingsDialog` just composes it ahead of the
`StartupTerminalsTab` panel.

`InstructionTemplatesTab` also owns the "Task agents may type-check what they
edited" checkbox (`taskAgentTypecheck`, default OFF; backend
`taskVerification.ts`): seeded per open from the strict settings GET, patched
(`getTaskAgentTypecheckPatch`) only once the user flips it.

`EnvNotesTab` likewise owns the "Task worktrees check out Git LFS files as
pointers (saves disk)" checkbox (`taskWorktreeLfsContent`, default
`'pointers'`; backend `worktree/lfsMode.ts`), on the same pattern:
seeded per open, patched (`getTaskWorktreeLfsContentPatch` → `'pointers'` /
`'full'`) only after a user flip, and counted in the Agent-prompts dirty flag.

`useOverrideDraft.ts` is the shared draft engine behind the two
**override-merge** tabs (`InstructionTemplatesTab` + `EnvNotesTab`): both fetch
a list of items + the saved override map (gated on `open && active`, and only
ONCE per dialog-open per project — switching tabs and back must not re-seed,
which silently dropped unsaved edits; `getPatch` also returns `undefined` while
the seeded project isn't the active one, so a project switch with the dialog
open never saves one project's drafts into another; `HarnessSystemPromptsTab`
follows the same rule), keep an
editable text draft per item, and on Save clone the saved overrides then per
item either drop the key (draft means "use Lattice's default") or write the
edited text — with the `undefined`-until-loaded clobber-guard above. It's
parameterized by `fetchItems` and `matchesDefault` (the one real divergence:
instruction templates drop on blank-or-exact-default, env notes on trimmed
equality). Keep these tabs on the shared hook rather than re-copying the
clobber-guard logic.

`InstructionTemplatesTab` renders one `TemplateCard.tsx` per template: a
collapsible card (title / Modified badge / filename / reset-to-default) with the
editable textarea and the click-to-insert `{{token}}` list. The insertion is
`useTokenInsertion.ts` — drops the token at the caret (or over the selection),
then refocuses and puts the caret after it; appends when the textarea isn't
mounted. `HarnessSystemPromptsTab` renders one `HarnessSystemPromptCard.tsx` per
harness: the same collapsible card chrome over the read-only built-in default
overview plus the Append and Replace textareas (Replace carries its per-harness
warning); the card keeps only its own expanded state, drafts stay in the tab.

## Where each setting persists

**Per-project** — `userSettings.json`, via `PATCH /api/settings`:
`InstructionTemplatesTab` + `HarnessSystemPromptsTab` + `EnvNotesTab` (all three
on the Agent-prompts tab), `MetricsIgnoredExtsTab`, `StartupTerminalsTab`, the
MCP per-project enables (`mcpOverrides` for Claude, `mcpHarnessOverrides` for
Codex/Pi, plus `mcpPlaywrightHeaded` and the top-of-tab
`taskAgentsLatticeMcpOnly` checkbox — default ON, its own touched flag), plus
the parent's terminal-default /
instrument / memory drafts.

`HarnessSystemPromptsTab` edits `UserSettings.harnessSystemPrompts` (per-harness
`{append, replace}` — the agent's own built-in system prompt, not a Lattice
brief). It fetches `GET /api/harness-system-prompts` (default overview + current
override) via a bespoke draft hook (the saved shape is nested, not the flat
`Record<string,string>` the shared `useOverrideDraft` handles) with the same
`undefined`-until-loaded clobber-guard, and its `getHarnessSystemPromptsPatch()`
returns the full desired map. Read-only harness *defaults* come from
`backend/src/harnessSystemPrompts/`.

**Machine-global** — `globalSettings.json`, via `PATCH /api/global-settings`:
`AgentsTab` (`maxConcurrentAgents`), `PiTab` (`piProviders` + `piModelMenu`),
the MCP tab's custom-server defs (`mcpCustomServers`, written immediately on
add/remove — not via the footer), and `ToolsTab`'s rule-pack enables
(`opengrep.packs`).

(These tabs read/write the global file
directly, not `userSettings` — don't assume "a tab ⇒ per-project".)

**`ToolsTab`** (Opengrep, SAST) spans immediate engine/rule-pack operations,
machine-global pack enables and per-project scan settings. Its module map,
save guards and async lifetime rules live in [tools/CLAUDE.md](tools/CLAUDE.md).

`PiTab` manages OpenAI-compatible Pi endpoints (id / baseUrl /
apiKey / models, with a "Detect models" probe via `POST /api/pi-endpoints/probe`
that also captures each model's advertised context window and shows it as a
"262K ctx" badge), plus a per-endpoint **Advanced** section (the provider `api`
protocol as a select over Pi's four supported values — blank means
`openai-completions` — compat `thinkingFormat` / `supportsDeveloperRole` /
`supportsReasoningEffort`, and custom request headers). An **Auto-discover
models** checkbox (on by default) hands the model list to the backend's
`refreshEndpointDiscovery`; while it is on, the checklist is a read-only view of
what the endpoint serves, since a hand un-tick would be undone by the next
refresh. Each row also badges what was detected: extended thinking levels
(`xhigh · max`) and the context window. The **Pi model menu** section below marks
those same patterns fixed (`alwaysShownPatterns`) because the backend surfaces
them regardless of curation — a checkbox that silently does nothing is worse than
no checkbox. Both the fixed rendering and the backend bypass stop at
`AGGREGATOR_MODEL_COUNT` (5, mirroring the backend constant): past it the card
says so and the models go back to being curated by hand.
`useProbeDetection.seed(providers)` primes each endpoint's `detected` map from
its SAVED models on load: the checklist shows `detected ∪ selected`, so without
it, un-ticking a model in manual mode removed the only row that could put it
back (its models came from auto-discovery, not a probe click, so `detected` was
empty). The backend reconciles all
of this into `~/.pi/agent/models.json`, plus the curated "Pi — X" model-menu
checklist. (A keyless endpoint is written with `apiKey: "local"` so Pi doesn't
reject the whole file — see `backend/src/piModels.ts`.) `PiTab`'s draft state
lives in three focused hooks in `usePiEndpoints.ts`: `useEndpointState` (the
endpoint list + `touched` flag + `patch`/`add`/`remove`, and a shared `mutate`
primitive the editors reuse for their compat/header/model/detect edits;
`add` derives the next `endpoint-N` id from the current list via
`nextEndpointId` so a fresh row never re-mints a saved id), `useProbeDetection`
(per-endpoint `probing`/`detected`/`probeError` + the `/api/pi-endpoints/probe`
flow, reporting `{id, contextWindow?}` entries back via an `onDetected`
callback — a reachable endpoint that lists nothing reports that as an error
rather than blinking silently — plus `dropEndpoint(id)` to forget a removed
endpoint's state; a generation counter bumped by `reset()` (every dialog open)
and on unmount drops a probe from an earlier session, so a slow Detect started
before a Cancel can't land after reopen and clobber the curated models on the
next unrelated Save — `piProbeStaleSession.test.ts`), and `usePiEndpointEditors(endpoints,
probe, providers)` (the per-endpoint field editors — `updateCompat`,
the header mutators sharing one `mutateHeaderEntries` body, `toggleEndpointModel`,
`detectModels` — extracted out of `PiTab.tsx`; a probe result is applied to its
endpoint by id when it resolves — `applyDetectedModels` — never by the row index
captured at click time). **All per-endpoint transient
state — `useProbeDetection`'s three maps and `PiTab`'s `advancedOpen` — is keyed
by the endpoint's stable `ep.id`, not its array index** (the React `key` is
`ep.id` too), so removing a non-last endpoint never misattributes a survivor's
detected list / Advanced section / probe error; removal drops that id's entries.
Note: the `PATCH /api/global-settings` route now passes *all* machine-global
fields through (it previously forwarded only `maxConcurrentAgents`, silently
dropping the rest).

`PiTab.tsx` stays the orchestrator (loads endpoint providers, wires the
`PiTabHandle` save patch — `piProvidersPatch`, `undefined` until the saved list
LOADED *and* was touched, because the backend deletes every managed provider
missing from the list; a failed load shows an error and disables "Add endpoint") — with the per-endpoint editors in
`usePiEndpointEditors` and the model-menu draft/auto-include behavior in
`usePiModelMenuDraft` — and renders through focused pieces: `PiEndpointCard`
(one managed endpoint — id/baseUrl/key/detect/model checklist + the Advanced
toggle) wrapping `PiEndpointAdvanced` (compat + custom headers), and `PiModelMenu`
(the curated-menu checklist). `piTabUtils.ts` remains the compatibility barrel
for pure helpers in `piTabUtils/`: `headers.ts` owns cleanup and ordered row
edits; `providers.ts` owns compatibility edits, save gating/sanitization, endpoint
ids and transient-state removal; `models.ts` owns probe application and model/menu
derivation. Saves retain explicit empty maps to clear advanced overrides while
absent fields preserve hand-written configuration on adoption.
The card/advanced/menu pieces get index-pre-bound callbacks; all mutation still
flows through `useEndpointState`'s `mutate`.

`usePiModelMenuDraft` keeps menu checkboxes and its `toggle` entry point
read-only until this dialog session's saved-menu GET succeeds, including rows
retained across close/reopen. `PiModelMenu` shows loading status or a load error
with Retry; `getPatch` stays `undefined` while unavailable so Save preserves
the curated menu. Provider patterns are auto-included only after hydration,
and cancelled loads/errors cannot settle a later session. Pinned by
`__tests__/piModelMenuDraftLoading.test.ts`.

After a save that changed `piProviders`/`piModelMenu`, `saveSettings` calls
`notifyPiModelsChanged()` (`piModelMenuStore.ts`) so every mounted harness
dropdown refetches `GET /api/pi-models` without a page reload.

MCP **secrets** are separate again: stored in a `0600` file, written
immediately on entry — never through the Save button.

## `mcp/` subdir

MCP-tab-only UI, composed by `McpTab.tsx`:
- `McpServerRow` — one catalog row (three per-harness enable toggles + Playwright's
  cross-harness headed switch, badges, key field).
- `McpKeyField` — masked-but-confirmable secret entry (autosaves on blur; state
  machine in `useSecretField`).
- `McpAddCustom` — add a custom stdio/http server (definition only, no key).
- `McpImportSection` — import servers from other tools' MCP configs.

Within the MCP tab, secrets, custom-server defs, and imports each persist
**immediately** via their own API calls; only the per-project enables
(`mcpOverrides` / `mcpHarnessOverrides` / `mcpPlaywrightHeaded` /
`taskAgentsLatticeMcpOnly`) wait for Save, each behind its own touched flag.
