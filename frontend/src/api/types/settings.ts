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
  // Missing = OFF (the all-off-by-default invariant). `mcpOverrides.playwright`
  // is the GLOBAL Playwright toggle (Settings → MCP tab): injected into every
  // Lattice-spawned Claude session for the project and reconciled into the
  // user's own project-root config. See backend mcp/registry.ts.
  mcpOverrides?: Record<string, boolean>;
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
  // Per-project overrides of the agent instruction templates (task brief,
  // conflict resolver, QA / push / post-merge / workflow briefs), keyed by
  // template id. Value = raw markdown with `{{token}}` placeholders; a missing
  // or blank entry means "use Lattice's default". See backend
  // instructionTemplates/.
  instructionTemplateOverrides?: Record<string, string>;
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
    'terminalDefaultHarness' | 'terminalClaudeSkipPermissions'
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
