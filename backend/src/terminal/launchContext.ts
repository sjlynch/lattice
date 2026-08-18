import os from 'node:os';
import fs from 'node:fs';
import { ensureLatticeApiDoc } from '../latticeApiDocs.js';
import type { CreateOpts } from './sessionTypes.js';
import { applyFreshWindowsPath } from './windowsPath.js';
import { applyClaudeOverheadEnv } from './envSetup.js';
import {
  configureCodexProjectMcp,
  configureCodexProjectTrust,
  configureCodexSystemPrompt,
} from './codexTrust.js';
import { configureClaudeSystemPrompt } from './claudeSystemPrompt.js';

// Resolve the pty's default shell. Order: explicit per-spawn override
// (`opts.shell`, handled by the caller) → `LATTICE_DEFAULT_SHELL` operator
// escape hatch → platform default.
//
// The override is env-based on purpose: this runs in the *detached*
// terminal-server, which can't read Lattice's settings files, and every other
// knob it honors (`LATTICE_API_PORT`, `TERMINAL_PORT`, …) reaches it the same
// way. A locked-down Windows box can point this at `pwsh`/`powershell.exe`; a
// POSIX box at a specific shell.
//
// NOTE: on Windows `COMSPEC` is effectively always set (→ cmd.exe), so the
// previous `process.env.COMSPEC || 'powershell.exe'` could never reach the
// powershell fallback — it was dead code, and every Windows pty silently got
// cmd.exe (where a bash/PowerShell-shaped `$VAR` recipe does not expand at
// all — which is why the generated LATTICE_API.md bakes in literal values
// rather than shell references). The literal `'cmd.exe'` backstop here only
// matters in the pathological case where `COMSPEC` is unset. `platform`/`env`
// are injectable so the resolution is unit-testable across platforms.
export function resolveDefaultShell(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = os.platform(),
): string {
  const override = env.LATTICE_DEFAULT_SHELL?.trim();
  if (override) return override;
  if (platform === 'win32') return env.COMSPEC?.trim() || 'cmd.exe';
  return env.SHELL?.trim() || 'bash';
}

export type SessionLaunchContext = {
  shell: string;
  cwd: string;
  cols: number;
  rows: number;
  projectPath: string;
  env: { [key: string]: string };
  docPath: string | null;
  initialCommand?: string;
};

export function buildSessionLaunchContext(
  opts: CreateOpts,
): SessionLaunchContext | { error: string } {
  const shell = opts.shell?.trim() || resolveDefaultShell();
  const requestedCwd = opts.cwd?.trim();
  const cwd = requestedCwd || os.homedir();
  const cols = opts.cols ?? 80;
  const rows = opts.rows ?? 24;
  const projectPath = opts.projectPath?.trim() || cwd;

  const cwdError = validateRequestedCwd(requestedCwd);
  if (cwdError) return cwdError;

  // Generate/refresh this project's `.lattice/LATTICE_API.md` so the banner
  // below has something to point at. NOTE: agents do NOT discover the API from
  // the environment. Lattice used to export `LATTICE_API_URL` / `LATTICE_PROJECT`
  // / `LATTICE_PROJECT_HASH` / `LATTICE_DOCS` here as "breadcrumbs", but no
  // harness reads env vars into its context, so nothing ever saw them — and on
  // the Windows default shell (cmd.exe) a `$VAR`-shaped recipe wouldn't have
  // expanded anyway. Discovery is the always-on system-prompt preamble the
  // backend injects at the spawn chokepoint instead (see
  // harnessSystemPrompts/latticePreamble.ts); the generated doc bakes in literal
  // values so no recipe in it depends on shell expansion.
  const apiPort = Number(process.env.LATTICE_API_PORT) || 5184;
  const docPath = ensureLatticeApiDoc(projectPath, apiPort);

  // Opt this project's Lattice-spawned Claude session out of auto-memory when
  // the per-project setting says so (resolved at the POST /sessions chokepoint).
  // Scoped to this child process only — never the user's global Claude config.
  const overrideEnv: Record<string, string> = {};
  if (opts.disableClaudeMemory) {
    overrideEnv.CLAUDE_CODE_DISABLE_AUTO_MEMORY = '1';
  }

  const baseEnv: { [key: string]: string } = {
    ...(process.env as { [key: string]: string }),
  };
  applyFreshWindowsPath(baseEnv);
  applyClaudeOverheadEnv(baseEnv);

  // Secret env for managed MCP servers (Codex `env_vars`/`env_http_headers`
  // reference these by name). Merged into THIS child pty's env only — the
  // backend resolved the values and shipped them as data; they never touch the
  // terminal-server's own process env. Layered under overrideEnv, which wins on
  // any name clash (these are collision-resistant LATTICE_MCP_* / real secret
  // var names, so a clash is theoretical).
  const env = { ...baseEnv, ...(opts.managedMcpEnv ?? {}), ...overrideEnv };
  // Per-harness command rewriting. Each rewriter matches only its own harness's
  // leading command and no-ops otherwise, so chaining them is safe (a command
  // launches exactly one harness). Dynamic values (paths / TOML) ride in child
  // env vars the command references, never in shell source.
  //   - Claude: system-prompt override flags (replace/append files).
  //   - Codex : trust override, managed MCP `-c` overrides, system-prompt `-c`
  //             overrides.
  const claudeSysApplied = configureClaudeSystemPrompt(
    opts.initialCommand,
    {
      replaceFile: opts.claudeSystemPromptReplaceFile,
      appendFile: opts.claudeSystemPromptAppendFile,
    },
    shell,
    env,
  );
  const trusted = configureCodexProjectTrust(claudeSysApplied, cwd, shell, env);
  const withMcp = configureCodexProjectMcp(
    trusted,
    opts.managedCodexConfigArgs,
    shell,
    env,
  );
  const initialCommand = configureCodexSystemPrompt(
    withMcp,
    opts.codexSystemPromptConfigArgs,
    shell,
    env,
  );

  return {
    shell,
    cwd,
    cols,
    rows,
    projectPath,
    env,
    docPath,
    initialCommand,
  };
}

function validateRequestedCwd(cwd: string | undefined): { error: string } | null {
  // Refuse to spawn into a non-existent cwd. Without this, pty.spawn
  // succeeds on Windows but the shell exits immediately — and if a
  // client is reconnecting in a loop (e.g. after a worktree was
  // deleted), every cycle spawns a doomed shell. The exit closes the
  // WS, the client reconnects, repeat forever. A simple existence
  // check turns that infinite loop into a one-shot error.
  if (!cwd) return null;
  try {
    const stat = fs.statSync(cwd);
    if (!stat.isDirectory()) {
      return { error: `cwd is not a directory: ${cwd}` };
    }
  } catch {
    return { error: `cwd does not exist: ${cwd}` };
  }
  return null;
}
