# backend/src/harnessSystemPrompts

Per-project, per-harness overrides of the **agent's own built-in system prompt**
(not a Lattice-authored brief — that's `instructionTemplates/`). For each harness
(`claude` / `codex` / `pi`) a project can supply an **Append** string (added on
top of the built-in prompt) and/or a **Replace** string (swaps it entirely).
Edited in Settings → Agent prompts ("Harness system prompts"), stored on
`UserSettings.harnessSystemPrompts`, and injected at every spawn of that harness
in the project. `../harnessSystemPrompts.ts` is the public barrel.

## How each harness is overridden

The mechanism differs per harness because each CLI exposes the override
differently. All follow Lattice's "resolve in the backend, apply at spawn" split.

- **Claude** — `claude --system-prompt-file <replace>` and/or
  `--append-system-prompt-file <append>` (both work in interactive sessions).
  The text is written to a scratch file and the terminal-server adds the flag
  (`terminal/claudeSystemPrompt.ts`), the path riding a child-env var so it's
  never interpolated into shell source. Claude's *default* prompt is proprietary
  and can't be shown — the editor says so; the override still works.
- **Codex** — `-c developer_instructions=<append>` (an additive developer-role
  message) and/or `-c model_instructions_file=<replace-file>` (replaces the base
  instructions; needs a recent Codex, and OpenAI discourages it). The `-c`
  strings are applied by `configureCodexSystemPrompt` in `terminal/codexTrust.ts`
  on their own `LATTICE_CODEX_SYS_<i>` env-var series (distinct from the MCP
  overrides so both coexist).
- **Pi** — a Lattice-installed `before_agent_start` extension
  (`.pi/extensions/lattice-system-prompt.ts`) reading a JSON sidecar
  (`lattice-system-prompt.json`) with `{append, replace}` (see `piShim.ts`). Pi
  has no shell-safe CLI flag for a multi-line prompt and writing `.pi/SYSTEM.md`
  would clobber a user's own file, so the extension — mirroring
  `piExtension.ts`/`piMcp/` — is the collision-free route for both modes. Written
  into the session cwd by the backend at spawn (never rides the wire); stripped
  when there's no override so a reused cwd (the project root) stays clean.

## Modules

- `defs.ts` — **leaf catalog** (`HARNESS_SYSTEM_PROMPT_CATALOG`): per-harness
  read-only overview + best-available default text (real for Codex/Pi, an honest
  "not viewable" note for Claude) + per-field docs + source link, plus the
  shared types. Imports nothing from the resolver/injector, so both can import
  the catalog without a cycle.
- `resolve.ts` — `resolveHarnessSystemPrompt(projectPath, harness)`: the saved
  `{append, replace}` trimmed to only its non-empty sides, else `null`. The
  non-empty guard means a blank field never blanks out the built-in prompt.
- `editorData.ts` — `buildHarnessSystemPromptEditorData(project)`: the settings
  payload (catalog + the project's current Append/Replace text). Backs
  `GET /api/harness-system-prompts`.
- `piShim.ts` — renders + reconciles the Pi `before_agent_start` extension and
  its JSON sidecar (`applyPiSystemPromptForSpawn`). Byte-significant like
  `piExtension/template.ts`; skips a write when unchanged, removes the pair when
  there's no override.
- `inject.ts` — turns a resolved override into per-harness injection at the spawn
  chokepoint: `prepareClaudeSystemPrompt` (write files → paths),
  `prepareCodexSystemPrompt` (build `-c` arg strings), `preparePiSystemPrompt`
  (reconcile the extension). Scratch files live under
  `~/.lattice/per-project/<hash>/system-prompts/` (home-scoped, atomic writes).

## Where it's wired

- Resolved + applied at the single spawn chokepoint
  `terminalServerClient/createSession.ts` (`resolveHarnessSpawnBody`), so all
  spawn sites (task run/resume, workflow step, prompt customization, post-merge
  hook, push, QA, sidebar terminal, conflict resolver) are covered. Claude/Codex
  ride new `SessionWireBody` fields applied by `terminal/launchContext.ts`; Pi's
  files are written directly (like `piMcp`).
- The Pi extension + sidecar are registered Lattice-owned files in
  `worktree/managedFiles.ts` (gitignored + worktree-excluded).

## Invariants

- **A blank/whitespace-only field is ignored** (falls back to the built-in
  prompt on that side) — the safety net against an accidentally-cleared box.
- **Best-effort at spawn** — a resolve/write failure degrades to a plain spawn
  and never blocks it (`resolveHarnessSpawnBody` wraps each call in `.catch`).
- Injection is resolved in the main backend and applied by the terminal-server
  (Claude/Codex) or written as cwd files (Pi) — matching the MCP control plane,
  so a prompt edit is a backend-only change with no terminal-server respawn.
