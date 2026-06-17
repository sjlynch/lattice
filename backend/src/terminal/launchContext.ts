import os from 'node:os';
import fs from 'node:fs';
import { ensureLatticeApiDoc } from '../latticeApiDocs.js';
import { canonicalProjectPath, projectHash } from '../projectPath.js';
import type { CreateOpts } from './sessionTypes.js';
import { applyFreshWindowsPath } from './windowsPath.js';
import { applyClaudeOverheadEnv } from './envSetup.js';

const isWindows = os.platform() === 'win32';
const defaultShell = isWindows
  ? process.env.COMSPEC || 'powershell.exe'
  : process.env.SHELL || 'bash';

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
  const shell = opts.shell || defaultShell;
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
