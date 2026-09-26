> **Historical design note (June 2026).** Superseded by the code and
> `backend/src/projectClaude/CLAUDE.md`; details below (file layout, status) may be stale.
> Do not treat this as current behaviour.

# Plan: instrument ANY Claude session in an opened project (orange nodes for non-Lattice-launched sessions)

**Status: implemented; awaiting live verification.** Backend `tsc` + 151 tests
green, frontend `tsc -b` green.

## As-built checklist

- [x] `backend/src/userSettings.ts` + `frontend/src/api/types/settings.ts` —
  `instrumentProjectClaudeSessions?` (default ON / absent = true).
- [x] `backend/src/projectClaudeHooks.ts` (new) — merge-safe install/remove of
  the project's `.claude/settings.local.json` hooks (preserves user config,
  tagged by the `/api/project-activity/` URL, idempotent skip-if-unchanged).
  Tested: `__tests__/projectClaudeHooks.test.ts` (4 cases).
- [x] `backend/src/agentSessions.ts` — per-entry `lastSeen` + optional
  `idleTtlMs` + `touchAgentSession`; sweep now expires idle project sessions
  (5-min TTL) and runs every 60 s; `registerAgentSession` is idempotent
  (refresh-only when present). Public WS view strips the liveness fields.
- [x] `backend/src/routes/projectClaude.ts` (new) — `POST /api/project-instrumentation`
  (reads the setting → install/remove + `ensureLatticeGitignore` +
  `ensureTrustedClaudeDir`) and `POST /api/project-activity/:token`
  (SessionStart/End/Pre/Post → registry + beams, keyed by `session_id`,
  `.lattice/`+`~/.lattice/` cwd dedup). Mounted in `server/app.ts`.
- [x] `backend/src/claudeHookBody.ts` — `sessionIdFromHookBody` + `hookEventName`.
- [x] `backend/src/routes/agentActivity.ts` — `mapFileToProject` exported for reuse.
- [x] Frontend: `ensureProjectInstrumentation()` API; called on project open
  (`App.tsx`) and after the toggle saves; opt-out toggle in `SettingsDialog`
  (Terminals tab). Orange node + beams reuse the existing overlay (no new
  rendering).
- [x] Docs: root `CLAUDE.md` (HTTP table + conventions), `backend/src/CLAUDE.md`.

## Verify (live, user)

1. Reload the frontend (backend auto-restarts via the watcher). Opening the
   project triggers the hook install into `.claude/settings.local.json`.
2. **Start a FRESH `claude`** in a plain terminal at the project root (the
   session you're in now won't pick up the hooks — they load at session start),
   have it Read a few files → orange node + focus beams appear; node clears
   ~on exit (SessionEnd) or after 5-min idle.
3. Toggle off in Settings → save → confirm Lattice's hook entries are stripped
   from `.claude/settings.local.json` and your `permissions` survive.
4. Watch for a one-time Claude hook-approval prompt on first install — if it
   appears, that's the documented caveat; note the behavior.

---

## (original plan below)


## Goal

Show the orange Claude node + focus beams for **every** Claude Code session
working on a project opened in Lattice — including sessions Lattice did NOT
launch (a `claude` you start in your own terminal, or an IDE session) — not
just the push/workflow/post-merge sessions Lattice spawns itself.

## Why the current build misses it

Lattice can only install hooks into sessions it spawns (it writes a per-session
`.claude/settings.local.json` into each worktree/scratch dir). A `claude` you
launch yourself never goes through those spawn sites, so it has no Lattice
hooks and no registry entry → no node, no beams. (Verified live: the running
session's cwd is the project root, the project-root `.claude/settings.local.json`
holds only your permissions — no `hooks` block.)

## Mechanism (confirmed via Claude Code docs)

Write Lattice's activity hooks into the **project's own**
`<project>/.claude/settings.local.json`. Claude loads `hooks` from there for
**any** session whose working dir is inside the project tree (it resolves the
project by walking up to the git root), regardless of who launched it. Hooks
are additive (merge alongside the user's `permissions`) and the file is
gitignored.

Key facts that shape the design:
- `session_id` is in every hook payload and stable for the session → **node key**.
- `PreToolUse`/`PostToolUse` (matcher `Read|Edit|Write|MultiEdit|NotebookEdit`)
  carry `tool_input.file_path` → **beams**. `SessionStart`/`SessionEnd`
  (no matcher) → **presence**. `cwd` + `hook_event_name` are always present.
- Command hooks get the event JSON on stdin → `curl -s -d @-` forwards it.
  Only **exit 2** blocks a tool; an offline/slow curl (exit 7/28) never blocks
  the user's session.
- **Hooks load at session START.** A session already running when we write the
  hooks will NOT pick them up until it restarts. (So testing requires a fresh
  `claude` after install — and *this* session won't show.)
- Likely a one-time Claude trust/approval of the new hooks (undocumented) —
  needs an empirical check; pre-trust via `~/.claude.json` may or may not cover
  hooks.

## Reuse (no new frontend rendering)

`agentSessions.ts` (registry → `/ws/agent-sessions`) + `agentActivity.ts`
(`notifyAgentActivity` → `agent-activity` on `/ws/tasks`) + the orange-node
overlay already exist. Project sessions register into the **same** registry and
emit the **same** activity events, so the graph renders them with no frontend
overlay changes. Node id namespaced `claude:<session_id>` (never collides with
`push:` / `wf:` / `pmh:` / task ids).

## Backend changes

1. **Merge-safe project hooks writer** (new, e.g. `backend/src/projectClaudeHooks.ts`).
   - Read `<project>/.claude/settings.local.json` (or `{}`), preserve all
     existing keys (esp. `permissions`), merge in a `hooks` block:
     `PreToolUse`+`PostToolUse` (file-tool matcher) + `SessionStart`+`SessionEnd`,
     each a `command` curl to `POST /api/project-activity/<token>`.
   - **Idempotent + identifiable:** tag Lattice's hook entries (by the
     `/api/project-activity/` URL marker). On re-install, strip any existing
     Lattice entries then re-add — so we never duplicate and never touch the
     user's own hooks. Skip the write entirely if the file already matches
     (avoids churn that could re-trigger Claude's hook-approval).
   - `removeProjectHooks(project)` strips only the tagged entries (for opt-out).
   - Token encodes `{ projectPath, label: 'claude' }` via the existing
     `encodeAgentToken` (base64url, shell-safe). Project, not session — the
     session id comes from the body.

2. **Install trigger on project-open** (no backend project-open hook exists today).
   - New endpoint `POST /api/project-instrumentation { project }` that:
     `ensureLatticeGitignore(project)` (so `.claude/settings.local.json` is
     ignored even if no task ever ran) → `ensureTrustedClaudeDir(project)` →
     merge-install the hooks (or remove them if the toggle is off).
   - Frontend calls it once when `activeFolder` is set (and when the toggle
     changes). Gate on the new `UserSettings.instrumentProjectClaudeSessions`.

3. **Session-keyed endpoint** `POST /api/project-activity/:token` (new
   `routes/projectActivity.ts`, mounted in `server/app.ts`).
   - Decode token → project. Read `session_id`, `cwd`, `hook_event_name` from body.
   - **Dedup guard:** if `cwd` is under `<project>/.lattice/` or under
     `~/.lattice/` (worktree/scratch), 204 and skip — those sessions are
     already handled by their own machinery (prevents a workflow-step session
     double-registering).
   - Dispatch on `hook_event_name`:
     - `SessionStart` → `registerAgentSession({ agentId:'claude:'+sid, project, label:'claude', idleTtlMs })`.
     - `SessionEnd` → `unregisterAgentSession('claude:'+sid)`.
     - `PreToolUse`/`PostToolUse` → lazy-register (if missed SessionStart) +
       `touchAgentSession` + map file (under project root, skip managed/`.lattice`)
       + `notifyAgentActivity`.
   - Always 204.

4. **Registry idle-TTL** (`agentSessions.ts`).
   - Add per-entry `lastSeen` + optional `idleTtlMs`. The sweep expires
     idle-mode entries after ~90 s of no activity (covers a missed `SessionEnd`
     on a hard-killed terminal). `touchAgentSession(agentId)` refreshes it.
   - Lifecycle entries (push/wf/pmh, no `idleTtlMs`) keep current behavior
     (unregister on completion callback + 30-min safety).

## Frontend changes (small)

- `UserSettings.instrumentProjectClaudeSessions?: boolean` (type mirror) + a
  toggle in the settings dialog.
- Call `POST /api/project-instrumentation` on `activeFolder` change and on
  toggle change.
- Orange node + beams: **already done** (project sessions reuse the path).

## Decisions (settled 2026-06-13)

- **Install model: AUTO / opt-out.** Every project opened in Lattice is
  instrumented automatically. `UserSettings.instrumentProjectClaudeSessions`
  defaults to `true`; turning it off removes Lattice's hook entries from that
  project's `.claude/settings.local.json` (the user's own config is preserved).
- **Scope: project-level `<project>/.claude/settings.local.json`.** Not the
  global `~/.claude/settings.json`. Covers any session whose cwd is in the
  project tree; leaves unopened projects and global config untouched.

## Caveats to surface in the UI/docs

- A session must be **(re)started after install** to pick up the hooks; running
  sessions won't show until relaunched.
- The hook curls localhost on every file tool-use of every instrumented
  session; if the backend is down, `PreToolUse` adds up to its `-m 2` timeout
  to that tool call (never blocks — non-2 exit).
- Writing to the user's project `.claude/settings.local.json` is a real
  modification of their config — must be a clean, removable merge, and opt-out
  must fully strip Lattice's entries.
- Possible one-time Claude hook-approval prompt on first install — verify
  empirically; document if so.

## Verification plan

- Enable instrumentation on `C:\development\lattice`, start a fresh `claude`
  in a plain terminal at the project root, Read a few files → orange node +
  beams appear; idle ~90 s after it exits → node disappears.
- Confirm a workflow-step session does NOT double-register (cwd-dedup).
- Confirm the user's `permissions` survive install + opt-out strips cleanly.
- `tsc` both sides + tests.
