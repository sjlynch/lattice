import type { AgentHarness, HarnessAvailability, HarnessChoice } from '../../harnesses';

export type StartupTerminal = {
  id: string;
  label: string;
  command: string;
};

export type TerminalDefaultHarness = AgentHarness | 'terminal';

export type TerminalLaunchSettings = {
  terminalDefaultHarness: TerminalDefaultHarness;
  terminalClaudeSkipPermissions: boolean;
  // Whether Codex launches with `--yolo` (its analogue of Claude's
  // `--dangerously-skip-permissions`). Drives the sidebar's new-Codex-terminal
  // default; also read by the backend for every Codex agent spawn. Default ON.
  codexYolo: boolean;
};

export type UserSettings = {
  sidebarWidth?: number;
  harness?: HarnessChoice;
  // Per-project default Pi model ("provider/model"), chosen via the "Pi — X"
  // rows in the harness dropdown. Only used when the harness is `pi`.
  piModel?: string;
  startupTerminals?: StartupTerminal[];
  terminalDefaultHarness?: TerminalDefaultHarness;
  terminalClaudeSkipPermissions?: boolean;
  // Whether Codex launches with `--yolo` for this project (its analogue of
  // Claude's `--dangerously-skip-permissions`). Applies to every Codex session
  // Lattice spawns plus the sidebar's new-Codex-terminal default. Default ON —
  // absent counts as `true`; only an explicit `false` runs plain `codex`. See
  // backend userSettings.ts.
  codexYolo?: boolean;
  // Terminal-tab restore on project open (see backend terminalRegistry/).
  // 'always' (default) | 'ask' | 'never'.
  restoreTerminalsOnOpen?: 'always' | 'ask' | 'never';
  // Send the continue-nudge to relaunched task / merge-resolver agents.
  // Default ON (absent counts as true).
  restoreNudgeAgents?: boolean;
  // Also nudge relaunched sidebar (user) harness tabs — only when the
  // interruption detector finds the agent was mid-turn. Default OFF.
  restoreNudgeUserTabs?: boolean;
  workflowStepsCollapsed?: Record<string, boolean>;
  // Per-env override of the auto-injected "fresh worktree, don't reinstall"
  // note in task instructions. Key = env id; '' suppresses the note;
  // absent key = use the built-in default. See backend worktree/envDetect.ts.
  worktreeEnvNotes?: Record<string, string>;
  // Extensions (leading dot, lowercase) to skip when rendering the LOC
  // (`z`) and code-health (`h`) overlays. Absent = `DEFAULT_METRICS_IGNORED_EXTS`.
  metricsIgnoredExts?: string[];
  // Optional post-merge hook. See backend userSettings.ts.
  postMergeHookPrompt?: string;
  // Master on/off switch for the post-merge hook. The hook fires only when it
  // is enabled AND `postMergeHookPrompt` is non-empty. Default ON — absent
  // counts as `true`. See backend userSettings.ts.
  postMergeHookEnabled?: boolean;
  postMergeHookHarness?: AgentHarness;
  // Pi model for the post-merge hook, used only when postMergeHookHarness is `pi`.
  postMergeHookPiModel?: string;
  // When true (default — absent counts as true), Lattice instruments the
  // project's `.claude/settings.local.json` so any Claude session working in
  // the project tree shows as an orange node on the graph. See backend
  // projectClaudeHooks.ts.
  instrumentProjectClaudeSessions?: boolean;
  // When true (default — absent counts as true), Lattice turns Claude's
  // auto-memory OFF for this project: spawned agents get
  // CLAUDE_CODE_DISABLE_AUTO_MEMORY=1 and the project's own
  // `.claude/settings.local.json` gets `autoMemoryEnabled: false`. Per-project
  // / Local scope only — never the machine-global ~/.claude/settings.json. See
  // backend userSettings.ts.
  disableClaudeMemory?: boolean;
  // Per-project MCP-server on/off overrides, keyed by catalog server id.
  // Missing = OFF (the all-off-by-default invariant). This is CLAUDE's toggle
  // map (Codex/Pi use `mcpHarnessOverrides` below). `mcpOverrides.playwright`
  // is the GLOBAL Playwright toggle (Settings → MCP tab): injected into every
  // Lattice-spawned Claude session for the project and reconciled into the
  // user's own project-root config. See backend mcp/registry.ts.
  mcpOverrides?: Record<string, boolean>;
  // Per-harness MCP toggle maps for Codex and Pi (Claude keeps `mcpOverrides`).
  // `{ codex?: { [id]: boolean }, pi?: { [id]: boolean } }`; missing = OFF. Three
  // independent switches per server so enabling for one harness never loads it
  // into another. See backend mcp/registry.ts.
  mcpHarnessOverrides?: Partial<Record<'codex' | 'pi', Record<string, boolean>>>;
  // When true, the MCP-tab Playwright server runs HEADED (visible browser) for
  // every Lattice-spawned session it's enabled in (Claude global + Codex/Pi
  // toggles). Absent/false = headless. QA-lane runs are unaffected — they keep
  // `qaPlaywright.headless`. See backend mcp/resolverPolicy.ts + registry.ts.
  mcpPlaywrightHeaded?: boolean;
  // Backs the QA-lane Playwright buttons — QA e2e runs ONLY (separate from the
  // global `mcpOverrides.playwright`). `enabled` injects Playwright into QA
  // "run an e2e test" sessions; `headless` (the eye toggle) appends --headless.
  qaPlaywright?: { enabled: boolean; headless: boolean };
  // When true, a QA-lane e2e (Playwright) terminal auto-closes the moment its
  // run finishes. Default (absent/false) keeps it open so the user can read the
  // verdict/output. Only the terminal lifecycle — the qa → done auto-advance is
  // unaffected. The backend resolves this at `/done` time; see backend
  // userSettings.ts / routes/qaRuns.ts.
  qaTerminalAutoClose?: boolean;
  // When true, a workflow agent step's terminal tab (`wf:stepN`) stays open
  // after the step finishes — the session is left idle instead of killed — so
  // its output can be read. Default (absent/false) closes it on advance. Close
  // the tab yourself to end the session. Backend: workflowRuns.ts.
  keepWorkflowStepTerminals?: boolean;
  // Per-project overrides of the agent instruction templates (task brief,
  // conflict resolver, QA / push / post-merge / workflow briefs), keyed by
  // template id. Value = raw markdown with `{{token}}` placeholders; a missing
  // or blank entry means "use Lattice's default". See backend
  // instructionTemplates/.
  instructionTemplateOverrides?: Record<string, string>;
  // Per-project, per-harness overrides of the AGENT'S OWN system prompt (the
  // harness's built-in prompt, not a Lattice brief). Keyed by harness, each with
  // an independent `append` (added on top of the built-in prompt) and `replace`
  // (swaps it entirely); a missing/blank side leaves that side alone. Edited in
  // Settings → Agent prompts ("Harness system prompts"). See backend
  // harnessSystemPrompts/.
  harnessSystemPrompts?: Partial<
    Record<'claude' | 'codex' | 'pi', { append?: string; replace?: string }>
  >;
  // Opengrep (SAST) scan configuration for this project. Edited in Settings →
  // Tools. Mirrors backend opengrep/settings.ts `OpengrepProjectSettings`.
  opengrep?: OpengrepProjectSettings;
};

export type OpengrepSeverity = 'ERROR' | 'WARNING' | 'INFO';

export type OpengrepProjectSettings = {
  extraRulePaths?: string[];
  excludeGlobs?: string[];
  severityFloor?: OpengrepSeverity;
  ignoreRuleIds?: string[];
  ignoreFingerprints?: string[];
  digestBudgetKb?: number;
};

// Extensions Lattice ignores by default in the LOC and code-health overlays.
// Config/data and prose files are often long but not meaningful code-health
// signal, so their line counts and fallback "smell" scores stay out of the
// metric overlays unless a project explicitly opts them back in.
export const DEFAULT_METRICS_IGNORED_EXTS: readonly string[] = [
  // Structured config / data — no real complexity signal, scored only by the
  // regex fallback analyzer, so their LOC + "smell" numbers are just noise.
  '.json',
  '.yaml',
  '.yml',
  '.toml',
  '.xml',
  '.csv',
  // Prose / docs.
  '.md',
  '.mdx',
  '.txt',
];

export function isTerminalDefaultHarness(
  value: unknown,
): value is TerminalDefaultHarness {
  return (
    value === 'claude' ||
    value === 'pi' ||
    value === 'codex' ||
    value === 'terminal'
  );
}

export function normalizeTerminalLaunchSettings(
  settings: Pick<
    UserSettings,
    'terminalDefaultHarness' | 'terminalClaudeSkipPermissions' | 'codexYolo'
  > | null | undefined,
): TerminalLaunchSettings {
  const defaultHarness = settings?.terminalDefaultHarness;
  return {
    terminalDefaultHarness: isTerminalDefaultHarness(defaultHarness)
      ? defaultHarness
      : 'claude',
    terminalClaudeSkipPermissions:
      typeof settings?.terminalClaudeSkipPermissions === 'boolean'
        ? settings.terminalClaudeSkipPermissions
        : true,
    // Default ON — only an explicit `false` disables `--yolo`.
    codexYolo: settings?.codexYolo !== false,
  };
}

// Coerce a raw extension entry to its canonical form (lowercased, single
// leading dot). Returns null for empties so callers can drop them.
export function normalizeIgnoredExt(raw: string): string | null {
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) return null;
  return trimmed.startsWith('.') ? trimmed : `.${trimmed}`;
}

// Resolves the saved value to the list that should actually be applied:
// `undefined` → the built-in default; everything else → normalized + deduped.
export function effectiveMetricsIgnoredExts(
  saved: string[] | undefined,
): string[] {
  if (saved === undefined) return [...DEFAULT_METRICS_IGNORED_EXTS];
  const seen = new Set<string>();
  for (const raw of saved) {
    const ext = normalizeIgnoredExt(raw);
    if (ext) seen.add(ext);
  }
  return [...seen];
}

export type { HarnessAvailability };

// --- Pi model discovery (GET /api/pi-models). See backend piModels.ts. ---

export type PiModelInfo = {
  provider: string;
  model: string;
  pattern: string; // `${provider}/${model}` — value for `pi --model`
  contextWindow?: string;
  thinking?: boolean;
};

// One curated dropdown entry. `label` excludes the "Pi — " prefix.
export type PiMenuEntry = { pattern: string; label: string };

export type PiModelsResult = {
  models: PiModelInfo[];
  menu: PiMenuEntry[];
  defaultPattern: string | null;
};

// One model reported by an endpoint probe (POST /api/pi-endpoints/probe).
// `contextWindow` is present only when the server advertised one (vLLM's
// `max_model_len`, llama.cpp's `context_length`, …); it is carried onto the
// saved provider model so models.json gets the server's real window rather
// than Pi's conservative default. See backend piModels/probe.ts.
export type PiProbeModel = { id: string; contextWindow?: number };
