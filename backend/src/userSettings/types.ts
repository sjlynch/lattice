import type { AgentHarness } from '../harnesses.js';
import type { OpengrepProjectSettings } from '../opengrep/settings.js';

export type StartupTerminal = {
  id: string;
  label: string;
  command: string;
};

export type TerminalDefaultHarness = AgentHarness | 'terminal';

export type UserSettings = {
  sidebarWidth?: number;
  harness?: AgentHarness | 'interleave';
  // Per-project default Pi model ("provider/model", optionally `:thinking`),
  // chosen via the "Pi — X" rows in the harness dropdown. Only consulted when
  // the resolved harness is `pi` and the run/resume request didn't carry an
  // explicit model. Absent = Pi's own configured default. See piModels.ts.
  piModel?: string;
  startupTerminals?: StartupTerminal[];
  terminalDefaultHarness?: TerminalDefaultHarness;
  terminalClaudeSkipPermissions?: boolean;
  // Whether Codex is launched with `--yolo` (its analogue of Claude's
  // `--dangerously-skip-permissions`: run tool calls without prompting).
  // Applies to EVERY Codex session Lattice spawns — task runs/resumes,
  // workflow steps, the post-merge hook, prompt customization — plus the
  // sidebar's new-Codex-terminal default. Default is ON: an absent setting
  // counts as `true`, only an explicit `false` runs plain `codex`. See
  // `isCodexYoloEnabled` in features.ts.
  codexYolo?: boolean;
  // Terminal-tab restore (backend/src/terminalRegistry/). When a project is
  // opened, the sidebar's tabs are rebuilt from the durable registry: live
  // ptys are re-attached, dead ones (after a crash / Ctrl+C / reboot) are
  // relaunched into their previous harness conversation.
  //   'always' (default) — restore silently on project open
  //   'ask'              — show a prompt in the sidebar first
  //   'never'            — only the manual "Restore tabs" button restores
  restoreTerminalsOnOpen?: 'always' | 'ask' | 'never';
  // Whether a relaunched task / merge-resolver agent is sent the continue
  // nudge (so it picks its work back up without anyone typing into the tab).
  // Default ON — absent counts as `true`.
  restoreNudgeAgents?: boolean;
  // Whether a relaunched USER tab (a sidebar claude/pi/codex) is nudged too.
  // Default OFF, and even when on the nudge is only sent when the interruption
  // detector finds positive evidence the agent was mid-turn when it died.
  restoreNudgeUserTabs?: boolean;
  // Per-step collapse state for the workflow editor, keyed by step id.
  // Only collapsed=true entries are persisted to keep the file tidy.
  workflowStepsCollapsed?: Record<string, boolean>;
  // Per-environment override of the auto-injected "you're in a fresh
  // worktree, don't reinstall deps unless the task needs it" note that
  // Lattice prepends to LATTICE_TASK.md / MERGE_INSTRUCTIONS.md when it
  // detects a package-manager environment (see worktree/envDetect.ts).
  // Key = env id ('node' | 'python' | 'rust' | ...). An empty-string value
  // suppresses the note for that env entirely; a key being absent means
  // "use the built-in default".
  worktreeEnvNotes?: Record<string, string>;
  // File extensions (leading dot, lowercase) to skip when rendering the
  // LOC overlay (`z`) and the code-health overlay (`h`). Matching files
  // fall back to the normal sprite — no colored treatment, no LOC/score
  // label. Absent = use the frontend's DEFAULT_METRICS_IGNORED_EXTS
  // (JSON/YAML plus common prose/text extensions); an empty array means
  // "ignore nothing".
  metricsIgnoredExts?: string[];
  // Extra entry-point globs for the dead-code (`D`) overlay's reachability
  // pass, project-relative with `**`/`*`/`?` support (e.g. `src/routes/**`,
  // `**/*.stories.tsx`). Files matching these are treated as live roots even
  // when nothing imports them — the escape hatch for framework magic
  // (file-based routing, DI registries, plugin globs) that static import
  // resolution can't see. Conventional entry points (index/main/server/
  // *.config.*/tests) are detected automatically and don't need listing.
  deadCodeEntryGlobs?: string[];
  // Optional post-merge hook. When `postMergeHookPrompt` is non-empty,
  // every successful merge (per-task or "Merge All") spawns a coding
  // harness in the project root with this prompt as its task, and the
  // merge isn't considered finished until the harness's Stop hook (or
  // its explicit curl) fires the hook-complete callback. This blocks the
  // workflow Merge control step from advancing as well.
  postMergeHookPrompt?: string;
  // Master on/off switch for the post-merge hook. The hook fires only when
  // it is enabled AND `postMergeHookPrompt` is non-empty — the toggle lets a
  // user pause the hook without losing their prompt text. Default is ON
  // (absent counts as `true`) so an existing configured prompt keeps firing;
  // see `isPostMergeHookEnabled` in features.ts.
  postMergeHookEnabled?: boolean;
  postMergeHookHarness?: AgentHarness;
  // Pi model for the post-merge hook, used only when postMergeHookHarness is
  // `pi`. Sibling to postMergeHookHarness (see `piModel` above).
  postMergeHookPiModel?: string;
  // When true (the default — absent counts as true), Lattice merges activity
  // hooks into this project's `.claude/settings.local.json` so ANY Claude
  // session working in the project tree (even ones Lattice didn't launch)
  // shows as an orange node on the graph. Turning it off strips Lattice's
  // hook entries (the user's own config is preserved). See
  // `projectClaudeHooks.ts`.
  instrumentProjectClaudeSessions?: boolean;
  // When true (the DEFAULT — absent counts as true), Lattice turns Claude's
  // auto-memory OFF for this project: every agent Lattice spawns gets
  // `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` (see terminal/launchContext.ts) and the
  // project's own `.claude/settings.local.json` gets `autoMemoryEnabled: false`
  // (see projectClaudeHooks.ts). Both are Local/per-project scope — Lattice
  // never touches the machine-global `~/.claude/settings.json`, so Claude
  // memory in your other (non-Lattice) projects is unaffected. Set false to let
  // this project's Claude sessions use auto-memory.
  disableClaudeMemory?: boolean;
  // Per-project MCP-server on/off overrides, keyed by catalog server id. A
  // missing entry means OFF — the all-off-by-default invariant. The backend
  // reads this at every Claude spawn to decide what to inject (see
  // `mcp/registry.ts`). `mcpOverrides.playwright` is the GLOBAL Playwright
  // toggle (Settings → MCP tab): injected into every Lattice-spawned Claude
  // session for the project AND reconciled into the user's own project-root
  // entry. The QA-lane `qaPlaywright` toggle below is separate and QA-runs-only.
  //
  // NOTE: `mcpOverrides` remains CLAUDE's toggle map (kept for back-compat and
  // because Claude's Playwright has the extra QA scope). Codex and Pi use the
  // nested `mcpHarnessOverrides` below — three independent per-harness switches
  // per server, so enabling a server for one harness never loads it into another.
  mcpOverrides?: Record<string, boolean>;
  // Per-harness MCP toggle maps for Codex and Pi (Claude keeps `mcpOverrides`).
  // Shape: `{ codex?: { [serverId]: boolean }, pi?: { [serverId]: boolean } }`.
  // A missing harness map or a missing entry means OFF (all-off-by-default). The
  // backend reads this at every Codex/Pi spawn to decide what to inject (see
  // `mcp/registry.ts` → `resolveCodexServers` / `resolvePiServers`). Unlike
  // Claude, Codex/Pi have no QA-scoped Playwright — Playwright here is just a
  // per-harness toggle (headless unless `mcpPlaywrightHeaded` below is set).
  mcpHarnessOverrides?: Partial<Record<'codex' | 'pi', Record<string, boolean>>>;
  // When true, the MCP-tab Playwright server runs HEADED (a visible browser
  // window) for every Lattice-spawned session it's enabled in — Claude's global
  // toggle AND the Codex/Pi per-harness toggles. Absent/false = headless (the
  // default: unattended background sessions shouldn't pop a browser). This is
  // the "I want to watch it drive the browser" opt-in for ordinary task/sidebar/
  // workflow sessions. It does NOT affect QA-lane runs — those keep their own
  // headed/headless eye switch (`qaPlaywright.headless`), which stays
  // authoritative for QA. See `mcp/resolverPolicy.ts` + `mcp/registry.ts`.
  mcpPlaywrightHeaded?: boolean;
  // Backs the QA-lane Playwright buttons — QA e2e runs ONLY (not a global
  // enable; that's `mcpOverrides.playwright`). `enabled` injects the Playwright
  // MCP into QA-lane "run an e2e test" sessions; `headless` (the eye toggle, the
  // "watch it test" control) appends `--headless`. Absent = off / (when on)
  // headless.
  qaPlaywright?: { enabled: boolean; headless: boolean };
  // When true, a QA-lane e2e (Playwright) terminal AUTO-CLOSES the moment its
  // run finishes. Default (absent/false) keeps it OPEN so the user can read the
  // PASS/FAIL verdict and output. On auto-close the `/done` callback tears down
  // the pty + scratch (the original pre-toggle behavior); on stay-open it leaves
  // the live pty + scratch in place (the boot-time sweep reclaims the scratch
  // dir, and closing the tab kills the pty). Only the terminal lifecycle — the
  // qa → done auto-advance is unaffected either way. See routes/qaRuns.ts.
  qaTerminalAutoClose?: boolean;
  // When true, a workflow AGENT step's pty is left running (idle) when the step
  // completes instead of being killed, so its `wf:stepN` tab stays open with
  // the full session. Default (absent/false) kills it on advance — the
  // leak/overlap guard in workflowRuns/sessionSpawner.ts. The run advances
  // identically either way; closing the tab ends the session. Cancel/error
  // still tear sessions down. See workflowRuns.ts advanceCompletedStep.
  keepWorkflowStepTerminals?: boolean;
  // Per-project overrides of the agent instruction templates Lattice writes
  // (LATTICE_TASK.md, MERGE_INSTRUCTIONS.md, the QA/push/post-merge/workflow
  // briefs). Keyed by template id (see instructionTemplates/defs.ts). The
  // value is the raw markdown with `{{token}}` placeholders; a missing/blank
  // entry means "use the built-in default". Edited in Settings → Agent prompts
  // and applied at spawn via resolveInstructionTemplate.
  instructionTemplateOverrides?: Record<string, string>;
  // Per-project, per-harness overrides of the AGENT'S OWN system prompt (not a
  // Lattice-authored brief — the harness's built-in prompt). Keyed by harness
  // (`claude` | `codex` | `pi`), each with an independent `append` (added on
  // top of the built-in prompt) and `replace` (swaps it entirely) string; a
  // missing/blank side leaves that side of the built-in prompt alone. Edited in
  // Settings → Agent prompts ("Harness system prompts") and injected at every
  // spawn of that harness in this project (Claude `--(append-)system-prompt-file`,
  // Codex `developer_instructions`/`model_instructions_file`, a Pi
  // `before_agent_start` extension). See harnessSystemPrompts/.
  harnessSystemPrompts?: Partial<
    Record<'claude' | 'codex' | 'pi', { append?: string; replace?: string }>
  >;
  // Opengrep (SAST) scan configuration for this project: extra rule paths,
  // exclude globs, and what the agent-facing digest filters out (severity
  // floor, ignored rule ids / fingerprints) plus its size budget. Read
  // defensively by `opengrep/settings.ts` — a malformed value degrades to the
  // default. The rule-pack enables are machine-global (`globalSettings.opengrep`).
  opengrep?: OpengrepProjectSettings;
};
