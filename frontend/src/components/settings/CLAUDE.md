# frontend/src/components/settings

Tab panels and the save machinery for the Settings dialog. The parent,
`SettingsDialog.tsx` (one level up), is chrome only: a **`FloatingPanel`** (no
backdrop, so the app stays interactive; geometry under `lattice.settings.window`)
with the tab strip and one Save/Cancel footer. Tab-specific detail lives beside
the tab: Pi → [piEndpoints/CLAUDE.md](piEndpoints/CLAUDE.md), MCP →
[mcp/CLAUDE.md](mcp/CLAUDE.md), Tools/Opengrep → [tools/CLAUDE.md](tools/CLAUDE.md).

## Map

- `settingsTabs.ts` — `Tab` union, `SETTINGS_TABS` (label + `scope:
  'global' | 'project'`), `visibleSettingsTabs` / `resolveSettingsTab`.
- `useSettingsController.ts` — owns the per-tab `ref` handles, the session token,
  `saving` / `error`; runs the save. Keep handles thin save adapters; per-tab
  draft state goes in focused `use*Draft` hooks.
- `saveSettings.ts` — save orchestrator: `saveSettings` (reads every handle's
  `*Patch()`, merges the *defined* ones into one `PATCH /api/settings`, applies
  project Claude instrumentation, then `saveGlobalSettings`, then parent
  callbacks), `saveGlobalSettings`, `pickSavableTerminalLaunch`.
- `useSettingsDirty.ts` — `dirtyByTab` + a `bumpDirty` tick that re-reads the
  non-reactive patch getters after each body edit.
- `useSettingsCloseFlow.ts` — warn-on-unsaved close (`requestClose` →
  `confirmUnsaved`).
- `useSettingsDrafts.ts` + `fetchedToggles.ts` — drafts owned by the parent, not
  a tab: terminal-default harness / skip-permissions / Codex `--yolo` (default
  ON, part of `terminalLaunchSettings`; also feeds the sidebar's new-Codex
  command and every backend Codex spawn; its label must keep saying it disables
  the sandbox and approval prompts) plus the seven *fetched toggles*
  (instrument-Claude, disable-memory, QA auto-close, `keepWorkflowStepTerminals`,
  `restoreTerminalsOnOpen` / `restoreNudgeAgents` / `restoreNudgeUserTabs`).
  Adding a fetched toggle = key + default + read in `fetchedToggles.ts`, plus its
  value/setter pair on `SettingsDrafts`.
- `TerminalSettingsSections.tsx` — the project block atop the Terminals tab; a
  plain `drafts`-driven component with no ref handle (the controller persists
  those drafts). Single-checkbox sections are rows in
  `terminalToggleSections.tsx`'s `TERMINAL_TOGGLE_SECTIONS` (add one there);
  default-harness and restore sections stay hand-written.
  `StartupTerminalsTab.tsx` follows it (handle exposes `isTouched()`).
- `useOverrideDraft.ts` — shared draft engine for the two override-merge tabs,
  `InstructionTemplatesTab.tsx` (one `TemplateCard.tsx` each; `{{token}}`
  click-to-insert via `useTokenInsertion.ts`) and `EnvNotesTab.tsx`.
- `HarnessSystemPromptsTab.tsx` + `HarnessSystemPromptCard.tsx` — per-harness
  `{append, replace}` over `GET /api/harness-system-prompts`; bespoke draft hook
  (nested shape), same clobber-guard; `getHarnessSystemPromptsPatch()` returns
  the full map. Defaults owned by `backend/src/harnessSystemPrompts/`. The card
  holds only its expanded state; drafts stay in the tab.
- `MetricsIgnoredExtsTab.tsx`, `AgentsTab.tsx` (`maxConcurrentAgents`).
- `SettingsInfo.tsx` — the `(i)` popover holding long explanatory copy; keep
  section titles + control labels always visible and push detail into it.
  `SettingsSection.tsx` — structural-only section chrome + checkbox wrapper
  (callers own behavior).
- `PiTab.tsx`, `PiEndpoint*.tsx`, `PiModelMenu.tsx`, `usePiModelMenuDraft.ts`,
  `piEndpoints/`, `piTabUtils/` (+ the `usePiEndpoints.ts` / `piTabUtils.ts`
  barrels) → [piEndpoints/CLAUDE.md](piEndpoints/CLAUDE.md).
- `McpTab.tsx` + `mcp/`; `ToolsTab.tsx` + `tools/` → their own docs.

## Shared tab pattern

Each tab is a `forwardRef` panel that:
- (re)loads its saved value when the dialog `open`s into local **draft** state —
  nothing persisted changes until Save;
- exposes `get<Thing>Patch()` returning the value to persist, or **`undefined`**
  when untouched or not yet loaded. That `undefined` is the clobber-guard: an
  unrelated Save must never rewrite a value this tab didn't edit (or never
  loaded);
- renders `null` while `!active`, with every hook *before* that return so the
  handle stays live for a tab the user never opened.

Invariants:
- **Seed once per dialog-open per project.** Switching tabs and back must not
  re-seed (it silently dropped unsaved edits and cleared the dirty flag), and a
  patch is `undefined` while the seeded project isn't the active one, so a
  project switch with the dialog open never saves A's drafts into B
  (`useOverrideDraft`, `HarnessSystemPromptsTab`).
- **Session lifetime.** Every project/open transition creates a new controller
  session token, invalidated in layout-effect cleanup. An accepted save finishes
  persisting its captured project/global data, but parent callbacks, close and
  `saving`/`error` settle only while its session is active; a new session resets
  them at once. Path equality can't guard A → B → A or close/reopen. Pinned by
  `__tests__/settingsSaveLifetime.test.ts`.
- **No project open.** Only `scope: 'global'` tabs show (Agents / Pi / Tools; the
  default `terminals` falls through to Agents; MCP hidden — its enables are
  per-project) plus a scope note, and the controller calls
  `saveGlobalSettings` alone — never early-return, or Save (and the
  unsaved-changes prompt's Save) does nothing. Hidden per-project tabs stay
  mounted but skip their load on an empty folder, so their patches stay
  `undefined` and nothing reads dirty. Pinned by
  `__tests__/settingsTabsNoProject.test.ts`.
- **Seeded-from-App drafts.** Terminal-default drafts and `startupTerminals`
  come from App's shared `userSettings`, so they ride the `PATCH` only once it
  loaded (`settingsLoaded`, App → TopAppBar → SettingsDialog → controller) or
  per field the user edited (`getTerminalLaunchTouched()` →
  `pickSavableTerminalLaunch`; Startup's `isTouched()`). App resets
  `terminalLaunchSettings` while unloaded rather than keeping the previous
  project's; otherwise an unrelated save wipes the project's startup commands.
  Pinned by `__tests__/saveSettingsUnloaded.test.ts`.
- **Fetched toggles** ride the save only via `getSavableFetchedToggles()`
  (`pickSavableFetchedToggles`): all of them once this open's
  `fetchUserSettingsStrict` GET succeeded, else only touched ones — an unloaded
  draft holds its default and would reset the saved value. A late GET updates
  baselines but seeds only untouched drafts, never overwriting edits made while
  the dialog opened.
- **Override-merge** (`useOverrideDraft`): fetch gated on `open && active`; Save
  clones the saved override map, then per item drops the key (draft means "use
  Lattice's default") or writes the text. `matchesDefault` is the one
  divergence (templates: blank-or-exact-default; env notes: trimmed equality).
  Keep both tabs on the hook — don't re-copy the clobber-guard.
- `InstructionTemplatesTab` also owns `taskAgentTypecheck` (default OFF; backend
  `taskVerification.ts`) and `EnvNotesTab` owns `taskWorktreeLfsContent`
  (`'pointers'` default / `'full'`; backend `worktree/lfsMode.ts`): both seeded
  per open from the strict GET, patched only after a user flip, counted in the
  Agent-prompts dirty flag.
- `SettingsInfo`'s Escape handler is **capture-phase + `stopPropagation`**, so it
  closes just the popover, not the FloatingPanel; it also closes on
  outside-click.

## Where each setting persists

Don't assume "a tab ⇒ per-project".

- **Per-project** — `<project>/.lattice/userSettings.json` via
  `PATCH /api/settings`: `InstructionTemplatesTab` + `HarnessSystemPromptsTab` +
  `EnvNotesTab` (all on Agent prompts), `MetricsIgnoredExtsTab`,
  `StartupTerminalsTab`, the parent's terminal-default / fetched-toggle drafts,
  the MCP enables (`mcpOverrides`, `mcpHarnessOverrides`,
  `mcpPlaywrightHeaded`, `taskAgentsLatticeMcpOnly` — default ON, own touched
  flag) and Tools' scan filter (`opengrep`).
- **Machine-global** — `~/.lattice/globalSettings.json` via
  `PATCH /api/global-settings` (passes every global field through):
  `AgentsTab`, `PiTab` (`piProviders` + `piModelMenu`), Tools' pack enables
  (`opengrep.packs`) — all on the footer — and MCP custom-server defs
  (`mcpCustomServers`, written immediately).
- **Immediate, never via Save** — MCP secrets (`0600` file), MCP custom servers
  and imports, Opengrep engine/pack installs. Cancel doesn't undo them.
- After a save that changed `piProviders`/`piModelMenu`, `saveSettings` calls
  `notifyPiModelsChanged()` (`piModelMenuStore.ts`) so every mounted harness
  dropdown refetches `GET /api/pi-models` without a reload.

Tests: named after the module — grep it in `frontend/src/__tests__/`
(`overrideDraftTouched` and `settingsDraftLateFetch` also pin the draft rules
above). Styles: `styles/settings/` partials (see
`components/CLAUDE.md` → Styles).
