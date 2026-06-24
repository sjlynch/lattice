import fs from 'node:fs/promises';
import path from 'node:path';
// Import the constant from the leaf paths module, NOT from `./tasks.js` (which
// re-exports the whole task cache). This keeps userSettings — and therefore the
// MCP registry / detached terminal-server that now read it at spawn time — free
// of the heavy taskCache import chain.
import { PROJECT_DIR_NAME } from './taskCache/paths.js';
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
  // Per-project default Pi model ("provider/model", optionally `:thinking`),
  // chosen via the "Pi — X" rows in the harness dropdown. Only consulted when
  // the resolved harness is `pi` and the run/resume request didn't carry an
  // explicit model. Absent = Pi's own configured default. See piModels.ts.
  piModel?: string;
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
  mcpOverrides?: Record<string, boolean>;
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
  // Per-project overrides of the agent instruction templates Lattice writes
  // (LATTICE_TASK.md, MERGE_INSTRUCTIONS.md, the QA/push/post-merge/workflow
  // briefs). Keyed by template id (see instructionTemplates/defs.ts). The
  // value is the raw markdown with `{{token}}` placeholders; a missing/blank
  // entry means "use the built-in default". Edited in Settings → Agent prompts
  // and applied at spawn via resolveInstructionTemplate.
  instructionTemplateOverrides?: Record<string, string>;
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

// Whether Claude's auto-memory should be OFF for this project. Default is
// disabled (memory off) — an absent setting counts as `true`, matching the
// opt-out model used by instrumentProjectClaudeSessions. Read at every Claude
// spawn (terminal-server POST /sessions) and on project open / settings save
// (the project-instrumentation route).
export async function isClaudeMemoryDisabled(
  projectPath: string,
): Promise<boolean> {
  const settings = await getUserSettings(projectPath);
  return settings.disableClaudeMemory !== false;
}

// Whether a QA-lane e2e (Playwright) terminal should AUTO-CLOSE when its run
// finishes. Default is "stay open" (absent/false) so the user can read the
// PASS/FAIL verdict and output; only an explicit `true` opts into auto-close.
// Read by the QA-run `/done` callback to decide whether to tear the pty down.
export async function isQaTerminalAutoCloseEnabled(
  projectPath: string,
): Promise<boolean> {
  const settings = await getUserSettings(projectPath);
  return settings.qaTerminalAutoClose === true;
}
