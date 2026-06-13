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
  // When true (default — absent counts as true), Lattice instruments the
  // project's `.claude/settings.local.json` so any Claude session working in
  // the project tree shows as an orange node on the graph. See backend
  // projectClaudeHooks.ts.
  instrumentProjectClaudeSessions?: boolean;
};

// Extensions Lattice ignores by default in the LOC and code-health overlays.
// Config/data and prose files are often long but not meaningful code-health
// signal, so their line counts and fallback "smell" scores stay out of the
// metric overlays unless a project explicitly opts them back in.
export const DEFAULT_METRICS_IGNORED_EXTS: readonly string[] = [
  '.json',
  '.md',
  '.mdx',
  '.txt',
  '.yaml',
  '.yml',
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

export type ProjectEnvKind =
  | 'node'
  | 'python'
  | 'rust'
  | 'ruby'
  | 'php'
  | 'go'
  | 'maven'
  | 'gradle'
  | 'dotnet';

export type ProjectEnvInfo = {
  id: ProjectEnvKind;
  label: string;
  heavyDir: string;
  manager: string;
  installCmd: string;
  // The note Lattice would inject by default for this env.
  defaultNote: string;
  // What actually gets injected (user override if set, else defaultNote;
  // '' means the user suppressed it).
  effectiveNote: string;
};

export type ProjectEnvResponse = {
  environments: ProjectEnvInfo[];
};

export type { HarnessAvailability };
