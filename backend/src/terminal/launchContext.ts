import os from 'node:os';
import fs from 'node:fs';
import { ensureLatticeApiDoc } from '../latticeApiDocs.js';
import { canonicalProjectPath, projectHash } from '../projectPath.js';
import type { CreateOpts } from './sessionTypes.js';
import { applyFreshWindowsPath } from './windowsPath.js';
import { applyClaudeOverheadEnv } from './envSetup.js';

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
// cmd.exe (where the bash/PowerShell-shaped `$LATTICE_*` breadcrumbs don't
// expand). The literal `'cmd.exe'` backstop here only matters in the
// pathological case where `COMSPEC` is unset. `platform`/`env` are injectable
// so the resolution is unit-testable across platforms.
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

  // Plant breadcrumbs so AI agents running inside this pty can discover the
  // Lattice API without any user-side config. The vars only exist in this
  // child process; the user's shell env is untouched.
  const apiPort = Number(process.env.LATTICE_API_PORT) || 5184;
  const canonicalProject = canonicalProjectPath(projectPath);
  const latticeEnv: Record<string, string> = {
    LATTICE_API_URL: `http://127.0.0.1:${apiPort}`,
    LATTICE_PROJECT: canonicalProject,
    LATTICE_PROJECT_HASH: projectHash(canonicalProject),
  };
  const docPath = ensureLatticeApiDoc(projectPath, apiPort);
  if (docPath) latticeEnv.LATTICE_DOCS = docPath;

  // Opt this project's Lattice-spawned Claude session out of auto-memory when
  // the per-project setting says so (resolved at the POST /sessions chokepoint).
  // Scoped to this child process only — never the user's global Claude config.
  if (opts.disableClaudeMemory) {
    latticeEnv.CLAUDE_CODE_DISABLE_AUTO_MEMORY = '1';
  }

  const baseEnv: { [key: string]: string } = {
    ...(process.env as { [key: string]: string }),
  };
  applyFreshWindowsPath(baseEnv);
  applyClaudeOverheadEnv(baseEnv);

  return {
    shell,
    cwd,
    cols,
    rows,
    projectPath,
    env: { ...baseEnv, ...latticeEnv },
    docPath,
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
