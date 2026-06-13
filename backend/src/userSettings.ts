import fs from 'node:fs/promises';
import path from 'node:path';
import { PROJECT_DIR_NAME } from './tasks.js';
import { canonicalProjectPath } from './projectPath.js';
import type { AgentHarness } from './harnesses.js';

export type StartupTerminal = {
  id: string;
  label: string;
  command: string;
};

export type TerminalDefaultHarness = AgentHarness | 'terminal';

export type UserSettings = {
  sidebarWidth?: number;
  harness?: AgentHarness | 'interleave';
  startupTerminals?: StartupTerminal[];
  terminalDefaultHarness?: TerminalDefaultHarness;
  terminalClaudeSkipPermissions?: boolean;
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
  postMergeHookHarness?: AgentHarness;
  // When true (the default — absent counts as true), Lattice merges activity
  // hooks into this project's `.claude/settings.local.json` so ANY Claude
  // session working in the project tree (even ones Lattice didn't launch)
  // shows as an orange node on the graph. Turning it off strips Lattice's
  // hook entries (the user's own config is preserved). See
  // `projectClaudeHooks.ts`.
  instrumentProjectClaudeSessions?: boolean;
};

function settingsFile(projectPath: string): string {
  return path.join(projectPath, PROJECT_DIR_NAME, 'userSettings.json');
}

export async function getUserSettings(projectPath: string): Promise<UserSettings> {
  const key = canonicalProjectPath(projectPath);
  try {
    const raw = await fs.readFile(settingsFile(key), 'utf8');
    return JSON.parse(raw) as UserSettings;
  } catch {
    return {};
  }
}

export async function patchUserSettings(
  projectPath: string,
  partial: Partial<UserSettings>,
): Promise<UserSettings> {
  const key = canonicalProjectPath(projectPath);
  const current = await getUserSettings(key);
  const updated = { ...current, ...partial };
  const dir = path.join(key, PROJECT_DIR_NAME);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(settingsFile(key), JSON.stringify(updated, null, 2), 'utf8');
  return updated;
}
