# frontend/src/components/settings

Tab panels for the Settings modal. The parent, `SettingsDialog.tsx`, lives one
level up in `components/`: a `Modal` with a tab strip (Terminals / Agent
prompts / Metrics / Agents / MCP) that renders every tab and a single
Save/Cancel footer.

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

`saveSettings.ts` is the orchestrator. SettingsDialog hands it every tab's
handle (any may be `null` if unmounted), it reads each `*Patch()`, merges the
*defined* ones into one `PATCH /api/settings` body, then applies project Claude
instrumentation and the global max-agents patch, and finally fires the parent
callbacks. `useSettingsDrafts.ts` owns the handful of drafts that live on the
parent itself rather than a tab — the terminal-default harness +
skip-permissions, and the instrument-Claude / disable-memory toggles.

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
reject the whole file — see `backend/src/piModels.ts`.) Note: the `PATCH /api/global-settings` route now
passes *all* machine-global fields through (it previously forwarded only
`maxConcurrentAgents`, silently dropping the rest).

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
