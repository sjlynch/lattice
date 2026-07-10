# frontend/src/components/settings

Tab panels for the Settings dialog. The parent, `SettingsDialog.tsx`, lives one
level up in `components/`: a **`FloatingPanel`** (draggable/resizable/
maximizable, no backdrop so the app stays interactive; titlebar `×`/maximize;
geometry persisted under `lattice.settings.window`) with a tab strip (Terminals /
Agent prompts / Metrics / Agents / Pi / MCP) that renders every tab and a single
Save/Cancel footer. The dialog itself is now essentially just that chrome plus
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
the save (delegating to `saveSettings.ts`). Focused helpers keep the rest small:
`settingsTabs.ts` is the tab metadata + `Tab` union, `useSettingsDirty.ts`
derives the per-tab **dirty** map (`dirtyByTab` + a `bumpDirty` tick that
re-reads the non-reactive patch getters after each body edit), and
`useSettingsCloseFlow.ts` gates the warn-on-unsaved-close flow (`requestClose`
→ `confirmUnsaved`). The dialog spreads the returned `refs` onto each tab and
renders `saving` / `error` / `dirtyByTab`.

`saveSettings.ts` is the orchestrator. The controller hands it every tab's
handle (any may be `null` if unmounted), it reads each `*Patch()`, merges the
*defined* ones into one `PATCH /api/settings` body, then applies project Claude
instrumentation and the global max-agents patch, and finally fires the parent
callbacks. `useSettingsDrafts.ts` owns the handful of drafts that live on the
parent itself rather than a tab — the terminal-default harness +
skip-permissions, and the instrument-Claude / disable-memory / qa-auto-close
toggles. Its async settings load updates fetched baselines but seeds only
untouched toggle drafts, so a late GET never overwrites edits made while the
dialog was opening. `TerminalSettingsSections.tsx` renders those four sections
(the project-settings block atop the Terminals tab); it's a plain
`drafts`-driven component with no ref handle, since the controller persists
those drafts — `SettingsDialog` just composes it ahead of the
`StartupTerminalsTab` panel.

`useOverrideDraft.ts` is the shared draft engine behind the two
**override-merge** tabs (`InstructionTemplatesTab` + `EnvNotesTab`): both fetch
a list of items + the saved override map (gated on `open && active`), keep an
editable text draft per item, and on Save clone the saved overrides then per
item either drop the key (draft means "use Lattice's default") or write the
edited text — with the `undefined`-until-loaded clobber-guard above. It's
parameterized by `fetchItems` and `matchesDefault` (the one real divergence:
instruction templates drop on blank-or-exact-default, env notes on trimmed
equality). Keep these tabs on the shared hook rather than re-copying the
clobber-guard logic.

## Where each setting persists

**Per-project** — `userSettings.json`, via `PATCH /api/settings`:
`InstructionTemplatesTab` + `EnvNotesTab` (both on the Agent-prompts tab),
`MetricsIgnoredExtsTab`, `StartupTerminalsTab`, the MCP per-project enables
(`mcpOverrides`), plus the parent's terminal-default / instrument / memory
drafts.

**Machine-global** — `globalSettings.json`, via `PATCH /api/global-settings`:
`AgentsTab` (`maxConcurrentAgents`), `PiTab` (`piProviders` + `piModelMenu`),
and the MCP catalog (custom-server defs / built-in overrides). (These tabs
read/write the global file directly, not `userSettings` — don't assume "a tab
⇒ per-project".) `PiTab` manages OpenAI-compatible Pi endpoints (id / baseUrl /
apiKey / models, with a "Detect models" probe via `POST /api/pi-endpoints/probe`),
plus a per-endpoint **Advanced** section (compat `thinkingFormat` +
`supportsDeveloperRole`, and custom request headers). The backend reconciles all
of this into `~/.pi/agent/models.json`, plus the curated "Pi — X" model-menu
checklist. (A keyless endpoint is written with `apiKey: "local"` so Pi doesn't
reject the whole file — see `backend/src/piModels.ts`.) `PiTab`'s draft state
lives in three focused hooks in `usePiEndpoints.ts`: `useEndpointState` (the
endpoint list + `touched` flag + `patch`/`add`/`remove`, and a shared `mutate`
primitive the editors reuse for their compat/header/model/detect edits;
`add` derives the next `endpoint-N` id from the current list via
`nextEndpointId` so a fresh row never re-mints a saved id), `useProbeDetection`
(per-endpoint `probing`/`detected`/`probeError` + the `/api/pi-endpoints/probe`
flow, reporting ids back via an `onDetected` callback, plus `dropEndpoint(id)`
to forget a removed endpoint's state), and `usePiEndpointEditors(endpoints,
probe, providers)` (the ~dozen per-endpoint field editors — `updateCompat`,
the header mutators sharing one `mutateHeaderEntries` body, `toggleEndpointModel`,
`detectModels` — extracted out of `PiTab.tsx`). **All per-endpoint transient
state — `useProbeDetection`'s three maps and `PiTab`'s `advancedOpen` — is keyed
by the endpoint's stable `ep.id`, not its array index** (the React `key` is
`ep.id` too), so removing a non-last endpoint never misattributes a survivor's
detected list / Advanced section / probe error; removal drops that id's entries.
Note: the `PATCH /api/global-settings` route now passes *all* machine-global
fields through (it previously forwarded only `maxConcurrentAgents`, silently
dropping the rest).

`PiTab.tsx` stays the orchestrator (loads endpoint providers, wires the
`PiTabHandle` save patch) — with the per-endpoint editors in
`usePiEndpointEditors` and the model-menu draft/auto-include behavior in
`usePiModelMenuDraft` — and renders through focused pieces: `PiEndpointCard`
(one managed endpoint — id/baseUrl/key/detect/model checklist + the Advanced
toggle) wrapping `PiEndpointAdvanced` (compat + custom headers), and `PiModelMenu`
(the curated-menu checklist). Pure sanitization/derivation lives in
`piTabUtils.ts` (`cleanHeaders`, `entriesToHeaders`, `compatString`,
`sanitizeProvidersForSave` = the `getPiProvidersPatch` body — which also dedupes
duplicate ids so a hand-typed collision can't clobber models.json on reconcile —
`nextEndpointId`, `dropEndpointKey`, `collectModelUniverse` = the saved∪draft
pattern set) so the components stay thin and the save semantics stay testable.
The card/advanced/menu pieces get index-pre-bound callbacks; all mutation still
flows through `useEndpointState`'s `mutate`.

After a save that changed `piProviders`/`piModelMenu`, `saveSettings` calls
`notifyPiModelsChanged()` (`piModelMenuStore.ts`) so every mounted harness
dropdown refetches `GET /api/pi-models` without a page reload.

MCP **secrets** are separate again: stored in a `0600` file, written
immediately on entry — never through the Save button.

## `mcp/` subdir

MCP-tab-only UI, composed by `McpTab.tsx`:
- `McpServerRow` — one catalog row (enable toggle, badges, key field).
- `McpKeyField` — masked-but-confirmable secret entry (autosaves on blur).
- `McpAddCustom` — add a custom stdio/http server (definition only, no key).
- `McpImportSection` — import servers from other tools' MCP configs.

Within the MCP tab, secrets, custom-server defs, and imports each persist
**immediately** via their own API calls; only the per-project enables
(`mcpOverrides`) wait for Save.
